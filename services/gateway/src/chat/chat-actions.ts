// chat-actions.ts - server-owned Co-Pilot action-card registry

import { randomUUID } from 'node:crypto';

import {
  type ChatActionRejectReason,
  type ChatConfirmActionParams,
  type ChatConfirmActionResult,
  type ChatListActionsResult,
  type ChatSuggestedAction,
  failedRunCancelEffects,
  type Run,
  type RunCreateParams,
  type RunStep,
  type SlotStatus,
} from '@farmslot/protocol';

import { getCachedFleet } from '../fleet/state.js';
import { decisionList, decisionResolve } from '../methods/decisions.js';
import { assertDuplicateRunAllowed, runCreate, runResolveDecision } from '../methods/run.js';
import { runDelete } from '../methods/run/admin.js';
import { runCancel } from '../methods/run/lifecycle-control.js';
import { runReplayStep } from '../methods/run/replay-step.js';
import { slotPrepare, slotRelease } from '../methods/slot.js';
import { terminalSend } from '../methods/terminal.js';
import { getAllRuns, getRun, listRuns } from '../runs/store.js';

import {
  cloneJsonObject,
  normalizeActionParams,
  normalizeAgentRole,
  normalizeFlowType,
  stringParam,
  type SupportedChatActionType,
} from './chat-action-normalization.js';
import { saveMemory } from './chat-memory.js';
import { normalizeSessionId } from './chat-store.js';

type Emit = (event: string, payload: unknown) => void;

interface RunActionSnapshot {
  runId: string;
  createdAt: string;
  generation: number;
  slotId: string | null;
}

interface DecisionActionSnapshot {
  decisionId: string;
  actionId: string;
  runId: string;
  decisionCreatedAt: string;
  runCreatedAt: string;
  generation: number;
}

// Slot snapshot — captures the slot's identity-relevant fields so a deferred
// confirmation can detect that the slot has drifted (different lifecycle, swapped
// out from under us, or rebound to a different run). SlotStatus has no monotonic
// `generation`, so we use `currentRunId` + `lifecycle` together as the surrogate:
// any meaningful state change flips at least one of those.
interface SlotActionSnapshot {
  slotId: string;
  lifecycle: string;
  runId: string | null;
}

interface ActionGuardSnapshot {
  run?: RunActionSnapshot;
  decision?: DecisionActionSnapshot;
  slot?: SlotActionSnapshot;
}

interface ActionPreconditions {
  decisionRunId?: string;
}

// ChatActionRejectReason lives in @farmslot/protocol so the gateway throw
// list and the UI's classification set derive from one source of truth.
export type { ChatActionRejectReason };

export class ChatActionRejectError extends Error {
  constructor(
    public readonly reason: ChatActionRejectReason,
    message: string,
  ) {
    super(message);
    this.name = 'ChatActionRejectError';
  }
}

interface StoredChatAction {
  actionId: string;
  sessionId: string;
  type: SupportedChatActionType;
  label: string;
  params: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs: number;
  executingAtMs?: number;
  consumedAtMs?: number;
  guard?: ActionGuardSnapshot;
}

export const CHAT_ACTION_TTL_MS = 10 * 60 * 1000;
const CHAT_ACTION_REAPER_INTERVAL_MS = 60 * 1000;

const actionsById = new Map<string, StoredChatAction>();
const actionIdsBySession = new Map<string, Set<string>>();

function isStepInTerminalFailedState(step: RunStep | undefined): boolean {
  return step?.status === 'failed';
}

function indexAction(action: StoredChatAction): void {
  actionsById.set(action.actionId, action);
  const sessionActionIds = actionIdsBySession.get(action.sessionId) ?? new Set<string>();
  sessionActionIds.add(action.actionId);
  actionIdsBySession.set(action.sessionId, sessionActionIds);
}

function deleteIndexedAction(action: StoredChatAction): void {
  actionsById.delete(action.actionId);
  const sessionActionIds = actionIdsBySession.get(action.sessionId);
  if (!sessionActionIds) return;
  sessionActionIds.delete(action.actionId);
  if (sessionActionIds.size === 0) actionIdsBySession.delete(action.sessionId);
}

function sweepChatActions(nowMs = Date.now()): number {
  let removed = 0;
  for (const action of actionsById.values()) {
    const live = action.consumedAtMs === undefined && action.expiresAtMs > nowMs;
    if (live) continue;
    deleteIndexedAction(action);
    removed++;
  }
  return removed;
}

export function sweepChatActionsForTests(nowMs = Date.now()): number {
  return sweepChatActions(nowMs);
}

const chatActionReaper = setInterval(() => {
  sweepChatActions();
}, CHAT_ACTION_REAPER_INTERVAL_MS);
chatActionReaper.unref();

function runGeneration(run: Run): number {
  return run.engineState?.generation ?? 0;
}

function snapshotRun(run: Run): RunActionSnapshot {
  return {
    runId: run.id,
    createdAt: run.createdAt,
    generation: runGeneration(run),
    slotId: run.slotId ?? null,
  };
}

// Test seam: chat-actions.test.ts swaps the fleet lookup to drive
// snapshot-mismatch / RequiresExplicitMergeMain paths without a live fleet.
// Exposed via a globalThis side-channel under NODE_ENV==='test' so there's
// no production import surface that callers could accidentally reach.
type SlotLookup = (slotId: string) => SlotStatus | undefined;
const defaultSlotLookup: SlotLookup = (slotId) =>
  getCachedFleet()?.slots.find((s) => s.slot === slotId);
let slotLookup: SlotLookup = defaultSlotLookup;

interface FarmslotTestHooks {
  setSlotLookup?: (lookup: SlotLookup | null) => void;
  /** Mutate a stored action's params directly. Used to drive defense-in-depth
   *  branches (e.g. confirm-time replayStep gate) that the issue-time gate
   *  already filters out — the test simulates a fixture-seeded or re-issued
   *  card slipping past issuance. */
  patchStoredActionParams?: (actionId: string, patch: Record<string, unknown>) => boolean;
}
const TEST_HOOKS_KEY = '__farmslot_test_hooks__';
if (process.env.NODE_ENV === 'test') {
  const slot = globalThis as unknown as Record<string, FarmslotTestHooks | undefined>;
  const existing: FarmslotTestHooks = slot[TEST_HOOKS_KEY] ?? {};
  existing.setSlotLookup = (lookup) => {
    slotLookup = lookup ?? defaultSlotLookup;
  };
  existing.patchStoredActionParams = (actionId, patch) => {
    const action = actionsById.get(actionId);
    if (!action) return false;
    Object.assign(action.params, patch);
    return true;
  };
  slot[TEST_HOOKS_KEY] = existing;
}

function getSlot(slotId: string): SlotStatus | undefined {
  return slotLookup(slotId);
}

function snapshotSlot(slotId: string): SlotActionSnapshot | undefined {
  const slot = getSlot(slotId);
  if (!slot) return undefined;
  return {
    slotId: slot.slot,
    lifecycle: slot.lifecycle,
    runId: slot.currentRunId ?? null,
  };
}

function logChatActionRegister(action: StoredChatAction): void {
  console.log(
    `[chat-actions] register actionId=${action.actionId} sessionId=${action.sessionId} type=${action.type}`,
  );
}

function logChatActionConfirm(action: StoredChatAction): void {
  console.log(`[chat-actions] confirm actionId=${action.actionId} ok=true type=${action.type}`);
}

function logChatActionReject(
  actionId: string,
  reason: ChatActionRejectReason,
  type: string | undefined,
): void {
  console.log(
    `[chat-actions] reject actionId=${actionId} reason=${reason} type=${type ?? 'unknown'}`,
  );
}

function findUnresolvedRunDecision(
  decisionId: string,
  actionId?: string,
): { run: Run; decision: Run['decisions'][number] } | null {
  for (const run of getAllRuns()) {
    const decision = run.decisions.find(
      (candidate) =>
        candidate.id === decisionId &&
        !candidate.resolvedAt &&
        (!actionId || candidate.actions.some((action) => action.id === actionId)),
    );
    if (decision) return { run, decision };
  }
  return null;
}

function buildActionGuard(
  normalized: Pick<StoredChatAction, 'type' | 'params'>,
): ActionGuardSnapshot | undefined {
  if (
    normalized.type === 'run.cancel' ||
    normalized.type === 'run.delete' ||
    normalized.type === 'run.replayStep'
  ) {
    const runId = stringParam(normalized.params, 'runId');
    const run = runId ? getRun(runId) : undefined;
    return run ? { run: snapshotRun(run) } : undefined;
  }

  if (normalized.type === 'decision.resolve') {
    const decisionId = stringParam(normalized.params, 'decisionId');
    const actionId = stringParam(normalized.params, 'actionId');
    if (!decisionId || !actionId) return undefined;
    const found = findUnresolvedRunDecision(decisionId, actionId);
    return found
      ? {
          decision: {
            decisionId,
            actionId,
            runId: found.run.id,
            decisionCreatedAt: found.decision.createdAt,
            runCreatedAt: found.run.createdAt,
            generation: runGeneration(found.run),
          },
        }
      : undefined;
  }

  if (normalized.type.startsWith('slot.')) {
    const slotId = stringParam(normalized.params, 'slotId');
    if (!slotId) return undefined;
    const snapshot = snapshotSlot(slotId);
    return snapshot ? { slot: snapshot } : undefined;
  }

  return undefined;
}

export function issueChatSuggestedActions(
  sessionId: string,
  rawActions: ChatSuggestedAction[],
  nowMs = Date.now(),
): ChatSuggestedAction[] {
  const normalizedSessionId = normalizeSessionId(sessionId);

  const issued: ChatSuggestedAction[] = [];
  for (const rawAction of rawActions) {
    const normalized = normalizeActionParams(rawAction);
    if (!normalized) continue;

    if (normalized.type === 'run.replayStep') {
      const stepName = String(normalized.params.step);
      // Mirror the descriptor allowlist in operator.ts (runRecoveryProposal):
      // server-direct issuance is gated to {prepare, run}, so LLM-emitted cards
      // must be too — otherwise an operator can confirm a card for a step the
      // engine isn't ready to replay.
      if (stepName !== 'prepare' && stepName !== 'run') continue;
      const step = getRun(String(normalized.params.runId))?.steps?.find((s) => s.name === stepName);
      if (!isStepInTerminalFailedState(step)) continue;
    }

    const action: StoredChatAction = {
      actionId: `chat-action-${randomUUID()}`,
      sessionId: normalizedSessionId,
      type: normalized.type,
      label: normalized.label,
      params: cloneJsonObject(normalized.params),
      createdAtMs: nowMs,
      expiresAtMs: nowMs + CHAT_ACTION_TTL_MS,
      guard: buildActionGuard(normalized),
    };
    indexAction(action);
    logChatActionRegister(action);
    issued.push({
      actionId: action.actionId,
      type: action.type,
      label: action.label,
      params: cloneJsonObject(action.params),
      expiresAt: new Date(action.expiresAtMs).toISOString(),
    });
  }

  return issued;
}

// UI WS-reconnect reconciliation entrypoint. Unknown sessionId returns [] so the
// UI prunes stale cards uniformly after a gateway restart drops the registry.
export function listChatActions(
  sessionId: string,
  nowMs = Date.now(),
): ChatListActionsResult['actions'] {
  const ids = actionIdsBySession.get(normalizeSessionId(sessionId)) ?? new Set<string>();
  const out: ChatListActionsResult['actions'] = [];
  for (const id of ids) {
    const action = actionsById.get(id);
    if (!action) continue;
    if (action.consumedAtMs !== undefined) continue;
    if (action.expiresAtMs <= nowMs) continue;
    const params = cloneJsonObject(action.params);
    // Truncate terminal.send text to keep listChatActions cheap and avoid leaking long pasted content to a session enumerator.
    if (
      action.type === 'terminal.send' &&
      typeof params.text === 'string' &&
      params.text.length > 200
    ) {
      params.text = params.text.slice(0, 200) + '…';
    }
    out.push({
      actionId: action.actionId,
      type: action.type,
      params,
      issuedAt: new Date(action.createdAtMs).toISOString(),
    });
  }
  return out;
}

export function clearChatActionsForSession(sessionId: string): void {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const actionIds = actionIdsBySession.get(normalizedSessionId);
  if (!actionIds) return;
  // Route through deleteIndexedAction(action) so any future per-action index
  // (e.g. by run/slot/decision) gets cleaned up automatically. Iterate over a
  // snapshot so the mutation inside deleteIndexedAction doesn't disturb the loop.
  for (const actionId of [...actionIds]) {
    const action = actionsById.get(actionId);
    if (action) deleteIndexedAction(action);
    else actionsById.delete(actionId);
  }
  actionIdsBySession.delete(normalizedSessionId);
}

export function resetChatActionsForTests(): void {
  actionsById.clear();
  actionIdsBySession.clear();
}

function assertUnmutatedConfirmParams(params: ChatConfirmActionParams): void {
  // consumedAt is server-set on the response; an attacker (or buggy client)
  // that replays a successful confirm with the consumedAt echoed back must
  // be rejected, otherwise the freshness gate around consumedAtMs is moot.
  const forbiddenMutationFields = new Set([
    'params',
    'type',
    'label',
    'expiresAt',
    'result',
    'consumedAt',
  ]);
  const mutatedField = Object.keys(params as unknown as Record<string, unknown>).find((key) =>
    forbiddenMutationFields.has(key),
  );
  if (mutatedField) {
    throw new Error(`Mutated action confirmation rejected: unexpected field ${mutatedField}`);
  }
  if (typeof params.sessionId !== 'string' || !params.sessionId.trim()) {
    throw new Error('Invalid action confirmation: sessionId is required');
  }
  if (typeof params.actionId !== 'string' || !params.actionId.trim()) {
    throw new Error('Invalid action confirmation: actionId is required');
  }
}

function assertRunActionSnapshot(action: StoredChatAction, run: Run): void {
  const snapshot = action.guard?.run;
  if (!snapshot) {
    throw new ChatActionRejectError(
      'snapshot-mismatch',
      `Action precondition failed: run ${run.id} was not available when the action was proposed`,
    );
  }
  if (
    snapshot.runId !== run.id ||
    snapshot.createdAt !== run.createdAt ||
    snapshot.generation !== runGeneration(run)
  ) {
    throw new ChatActionRejectError(
      'snapshot-mismatch',
      `Action precondition failed: run ${run.id} changed since the action was proposed`,
    );
  }
  if (snapshot.slotId !== (run.slotId ?? null)) {
    throw new ChatActionRejectError(
      'snapshot-mismatch',
      `Action precondition failed: run ${run.id} moved slots since the action was proposed`,
    );
  }
}

function assertSlotActionSnapshot(action: StoredChatAction, slot: SlotStatus): void {
  const snapshot = action.guard?.slot;
  if (!snapshot) {
    throw new ChatActionRejectError(
      'snapshot-mismatch',
      `Action precondition failed: slot ${slot.slot} was not available when the action was proposed`,
    );
  }
  // Any lifecycle delta rejects: transient values (releasing/recycling/preparing)
  // can flip snapshot-mismatch even when slot identity is unchanged. Each branch
  // names the specific delta so the operator can act on the rejection without
  // round-tripping logs.
  if (snapshot.slotId !== slot.slot) {
    throw new ChatActionRejectError(
      'snapshot-mismatch',
      `Action precondition failed: slot id changed (snapshot=${snapshot.slotId}, current=${slot.slot})`,
    );
  }
  if (snapshot.lifecycle !== slot.lifecycle) {
    throw new ChatActionRejectError(
      'snapshot-mismatch',
      `Action precondition failed: slot ${slot.slot} lifecycle changed (snapshot=${snapshot.lifecycle}, current=${slot.lifecycle}); reissue the card`,
    );
  }
  if (snapshot.runId !== (slot.currentRunId ?? null)) {
    throw new ChatActionRejectError(
      'snapshot-mismatch',
      `Action precondition failed: slot ${slot.slot} bound run changed (snapshot=${snapshot.runId ?? 'none'}, current=${slot.currentRunId ?? 'none'})`,
    );
  }
}

async function assertCurrentPreconditions(action: StoredChatAction): Promise<ActionPreconditions> {
  if (action.type === 'run.create') {
    if (
      !normalizeFlowType(action.params.flowType) ||
      !stringParam(action.params, 'project') ||
      !stringParam(action.params, 'ticketOrPr')
    ) {
      throw new ChatActionRejectError(
        'precondition-fail',
        'Action precondition failed: run.create action is incomplete',
      );
    }
    const { runs: existing } = listRuns({ active: true });
    assertDuplicateRunAllowed(action.params as unknown as RunCreateParams, existing);
    return {};
  }

  if (action.type === 'run.cancel') {
    const runId = stringParam(action.params, 'runId');
    const run = runId ? getRun(runId) : undefined;
    if (!run)
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: run ${runId ?? ''} is no longer available`,
      );
    assertRunActionSnapshot(action, run);
    if (run.status === 'done' || run.status === 'failed' || run.status === 'cancelled') {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: run ${runId} is already terminal`,
      );
    }
    return {};
  }

  if (action.type === 'run.delete') {
    const runId = stringParam(action.params, 'runId');
    const run = runId ? getRun(runId) : undefined;
    if (!run)
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: run ${runId ?? ''} is no longer available`,
      );
    assertRunActionSnapshot(action, run);
    if (run.status !== 'done' && run.status !== 'failed' && run.status !== 'cancelled') {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: run ${runId} is not terminal`,
      );
    }
    return {};
  }

  if (action.type === 'run.replayStep') {
    const runId = stringParam(action.params, 'runId');
    const stepName = stringParam(action.params, 'step');
    if (!runId || !stepName) {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: run.replayStep is incomplete`,
      );
    }
    // Mirror the issue-time allowlist (operator descriptor allowlist + LLM-card
    // gate): only {prepare, run} can pass confirm. Defense-in-depth so a
    // future re-issue or fixture seed can't slip a non-allowed step through.
    if (stepName !== 'prepare' && stepName !== 'run') {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: run.replayStep restricted to {prepare, run} (got ${stepName})`,
      );
    }
    const run = getRun(runId);
    if (!run) {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: run ${runId} is no longer available`,
      );
    }
    // Stale-card protection — same RunActionSnapshot guard run.cancel /
    // run.delete use. Without this a confirmed replayStep card could re-run
    // against a generation-bumped run or a slot rebind that happened after
    // the card was issued.
    assertRunActionSnapshot(action, run);
    const step = run.steps?.find((s) => s.name === stepName);
    if (!isStepInTerminalFailedState(step)) {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: run ${runId} step ${stepName} is not in terminal failed state`,
      );
    }
    return {};
  }

  if (action.type === 'slot.release') {
    // No RequiresExplicitMergeMain check here: release is a teardown action,
    // it never re-runs preflight against a branch. The mergeMain gate only
    // matters for slot.prepare on review-pr slots where blindly resetting to
    // main would clobber the PR branch.
    const slotId = stringParam(action.params, 'slotId');
    if (!slotId) {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: slot.release is incomplete`,
      );
    }
    const slot = getSlot(slotId);
    if (!slot) {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: slot ${slotId} is no longer available`,
      );
    }
    assertSlotActionSnapshot(action, slot);
    return {};
  }

  if (action.type === 'slot.prepare') {
    const slotId = stringParam(action.params, 'slotId');
    if (!slotId) {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: slot.prepare is incomplete`,
      );
    }
    const slot = getSlot(slotId);
    if (!slot) {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: slot ${slotId} is no longer available`,
      );
    }
    assertSlotActionSnapshot(action, slot);
    return {};
  }

  if (action.type === 'terminal.send') {
    if (!stringParam(action.params, 'slotId') || !stringParam(action.params, 'text')) {
      throw new ChatActionRejectError(
        'precondition-fail',
        'Action precondition failed: terminal.send action is incomplete',
      );
    }
    return {};
  }

  if (action.type === 'memory.update') {
    if (!stringParam(action.params, 'content')) {
      throw new ChatActionRejectError(
        'precondition-fail',
        'Action precondition failed: memory content is empty',
      );
    }
    return {};
  }

  if (action.type === 'decision.resolve') {
    const decisionId = stringParam(action.params, 'decisionId');
    const actionId = stringParam(action.params, 'actionId');
    if (!decisionId || !actionId) {
      throw new ChatActionRejectError(
        'precondition-fail',
        'Action precondition failed: decision action is incomplete',
      );
    }

    const snapshot = action.guard?.decision;
    const runDecision = findUnresolvedRunDecision(decisionId, actionId);
    if (snapshot) {
      if (
        !runDecision ||
        runDecision.run.id !== snapshot.runId ||
        runDecision.run.createdAt !== snapshot.runCreatedAt ||
        runGeneration(runDecision.run) !== snapshot.generation ||
        runDecision.decision.createdAt !== snapshot.decisionCreatedAt
      ) {
        throw new ChatActionRejectError(
          'snapshot-mismatch',
          `Action precondition failed: decision ${decisionId} changed since the action was proposed`,
        );
      }
      return { decisionRunId: snapshot.runId };
    }
    if (runDecision) {
      throw new ChatActionRejectError(
        'snapshot-mismatch',
        `Action precondition failed: decision ${decisionId} changed since the action was proposed`,
      );
    }

    const pending = (await decisionList()).decisions.find((decision) => decision.id === decisionId);
    if (!pending) {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: decision ${decisionId} is no longer pending`,
      );
    }
    if (!pending.actions.some((actionOption) => actionOption.id === actionId)) {
      throw new ChatActionRejectError(
        'precondition-fail',
        `Action precondition failed: decision action ${actionId} is no longer available`,
      );
    }
  }

  return {};
}

async function executeStoredAction(
  action: StoredChatAction,
  emit: Emit,
  preconditions: ActionPreconditions,
): Promise<Record<string, unknown> | undefined> {
  if (action.type === 'run.create') {
    const result = await runCreate(action.params as unknown as RunCreateParams, emit);
    return { runId: result.run.id };
  }

  if (action.type === 'run.cancel') {
    const { effects } = await runCancel({
      runId: String(action.params.runId),
      ...(stringParam(action.params, 'reason') ? { reason: String(action.params.reason) } : {}),
    });
    // Confirmed-action results are shown to the operator; a partially applied cancel
    // must say so rather than read as a clean stop.
    const failed = failedRunCancelEffects(effects);
    return {
      runId: String(action.params.runId),
      ...(failed.length
        ? {
            partiallyApplied: true,
            failedEffects: failed.map((effect) => `${effect.name}: ${effect.detail ?? 'failed'}`),
          }
        : {}),
    };
  }

  if (action.type === 'run.delete') {
    await runDelete({ runId: String(action.params.runId) }, emit);
    return { runId: String(action.params.runId) };
  }

  if (action.type === 'terminal.send') {
    await terminalSend({
      slotId: String(action.params.slotId),
      text: String(action.params.text),
      ...(typeof action.params.enter === 'boolean' ? { enter: action.params.enter } : {}),
      ...(normalizeAgentRole(action.params.role)
        ? { role: normalizeAgentRole(action.params.role) }
        : {}),
      ...(stringParam(action.params, 'contextId')
        ? { contextId: String(action.params.contextId) }
        : {}),
      ...(stringParam(action.params, 'target') ? { target: String(action.params.target) } : {}),
    });
    return { slotId: String(action.params.slotId) };
  }

  if (action.type === 'memory.update') {
    await saveMemory(String(action.params.content));
    return undefined;
  }

  if (action.type === 'run.replayStep') {
    const runId = String(action.params.runId);
    const stepName = String(action.params.step);
    await runReplayStep({ runId, stepName }, emit);
    return { runId, stepName };
  }

  if (action.type === 'slot.release') {
    await slotRelease({ slotId: String(action.params.slotId) }, emit);
    return { slotId: String(action.params.slotId) };
  }

  if (action.type === 'slot.prepare') {
    // {slotId}-only payload — server resolves default branch internally and never
    // accepts mergeMain from Co-Pilot (operator uses CLI/run flags for opt-in integrate-main).
    await slotPrepare({ slotId: String(action.params.slotId) }, emit);
    return { slotId: String(action.params.slotId) };
  }

  if (preconditions.decisionRunId) {
    await runResolveDecision(
      {
        runId: preconditions.decisionRunId,
        decisionId: String(action.params.decisionId),
        actionId: String(action.params.actionId),
      },
      emit,
    );
  } else {
    await decisionResolve(
      {
        decisionId: String(action.params.decisionId),
        actionId: String(action.params.actionId),
      },
      emit,
    );
  }
  return { decisionId: String(action.params.decisionId), actionId: String(action.params.actionId) };
}

export async function confirmChatAction(
  params: ChatConfirmActionParams,
  emit: Emit,
  nowMs = Date.now(),
): Promise<ChatConfirmActionResult> {
  assertUnmutatedConfirmParams(params);
  const sessionId = normalizeSessionId(params.sessionId);

  let action: StoredChatAction | undefined;
  try {
    action = actionsById.get(params.actionId);
    if (!action) {
      throw new ChatActionRejectError('unknown', `Unknown action: ${params.actionId}`);
    }
    // This gateway is currently a single-operator localhost tool without per-WebSocket identity.
    // Session ownership prevents accidental cross-chat confirms inside that trust boundary;
    // connection binding belongs with a future authenticated multi-operator gateway.
    if (action.sessionId !== sessionId) {
      throw new ChatActionRejectError(
        'cross-session',
        `Action belongs to a different Co-Pilot session`,
      );
    }
    if (action.consumedAtMs !== undefined) {
      throw new ChatActionRejectError('consumed', `Action already consumed: ${params.actionId}`);
    }
    if (action.executingAtMs) {
      throw new ChatActionRejectError('consumed', `Action already in progress: ${params.actionId}`);
    }
    if (action.expiresAtMs <= nowMs) {
      deleteIndexedAction(action);
      throw new ChatActionRejectError('expired', `Action expired: ${params.actionId}`);
    }
    // Set the executing mark immediately after the consumed/expired gates,
    // synchronously, before any await. Closes the read-then-set window where
    // a refactor that adds an async hop between the executingAtMs check
    // above and the assignment below could let two concurrent confirms see
    // both checks pass before either marks executing.
    action.executingAtMs = nowMs;

    let result: Record<string, unknown> | undefined;
    try {
      const preconditions = await assertCurrentPreconditions(action);
      result = await executeStoredAction(action, emit, preconditions);
    } finally {
      // Single cleanup site so a SIGTERM mid-precondition can't leave the
      // executing-mark behind for the full 10-min TTL.
      delete action.executingAtMs;
    }
    // Mark consumed but keep the entry until TTL so a replay surfaces a typed
    // 'consumed' reject (not 'unknown'). The reaper sweeps consumed + expired
    // entries on its CHAT_ACTION_REAPER_INTERVAL_MS cycle.
    action.consumedAtMs = nowMs;
    logChatActionConfirm(action);

    return {
      ok: true,
      actionId: action.actionId,
      type: action.type,
      consumedAt: new Date(nowMs).toISOString(),
      ...(result ? { result } : {}),
    };
  } catch (err) {
    if (err instanceof ChatActionRejectError) {
      logChatActionReject(params.actionId, err.reason, action?.type);
    }
    throw err;
  }
}
