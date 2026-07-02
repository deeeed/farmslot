// engine-decisions.ts — Engine-level decisions, auto-resolution, and collision redirects

import { randomUUID } from 'node:crypto';

import {
  type DecisionAction,
  Events,
  type Run,
  type RunDecision,
  type RunDecisionPayload,
  type RunStatus,
} from '@farmslot/protocol';

import { getRun, listRuns, updateRun } from '../runs/store.js';

import {
  canReplayCollisionDecision,
  findLatestResolvedDecision,
  isReplayableResolvedHumanGateDecision,
  latestResolvedHumanGateDecision,
} from './decision-replay.js';
import { hasValidPrNumber } from './gate-policy.js';
import { requiresPublicationApproval } from './publication-policy.js';

type BroadcastFn = (event: string, payload: unknown) => void;

let broadcastFn: BroadcastFn = () => {};
let stepToStatus: Record<string, RunStatus> = {};

export function setEngineDecisionRuntime(runtime: {
  broadcast: BroadcastFn;
  stepToStatus: Record<string, RunStatus>;
}): void {
  broadcastFn = runtime.broadcast;
  stepToStatus = runtime.stepToStatus;
}

/**
 * Thrown by the WRITE_TASK collision → comparison-lane redirect path. Signals to
 * the outer step catch that the current run is intentionally cancelled (forked
 * into a successor run), not failed. The catch checks `instanceof` and skips
 * the failure-marking branch so the run shows as `cancelled` with a
 * `redirectedToRunId` link instead of a misleading `error`.
 */
export class RedirectedError extends Error {
  readonly successorRunId: string;
  constructor(successorRunId: string, message: string) {
    super(message);
    this.name = 'RedirectedError';
    this.successorRunId = successorRunId;
  }
}

// ─── Decision creation + wait (for engine-level decisions like collision) ───

const engineDecisionResolvers = new Map<string, (actionId: string) => void>();

export function resolveEngineDecision(decisionId: string, actionId: string): void {
  const resolver = engineDecisionResolvers.get(decisionId);
  if (resolver) {
    resolver(actionId);
    engineDecisionResolvers.delete(decisionId);
  }
}

export function collisionAutoResolveAction(run: Run): 'create-new' | null {
  // Comparison-lane runs already file as siblings — collision means reuse the task
  // dir basename with a timestamp suffix, not fork again into comparison.
  if (run.lane === 'comparison') return 'create-new';
  if (run.mode === 'validation' || run.mode === 'autonomous') return 'create-new';
  return null;
}

/** Collision card actions; omit start-comparison when the run is already comparison-lane. */
export function collisionDecisionActions(current: Pick<Run, 'lane'>): DecisionAction[] {
  const actions: DecisionAction[] = [
    {
      id: 'create-new',
      label: 'Create new (append timestamp)',
      style: 'primary',
      description:
        'Creates a fresh task dir with a timestamp suffix and dispatches as a new production-lane root run. Use when the prior dirs are stale/abandoned and you just want to retry from scratch — does not link to existing runs.',
    },
  ];
  if (current.lane !== 'comparison') {
    actions.push({
      id: 'start-comparison',
      label: 'Start comparison lane',
      style: 'secondary',
      description:
        'Files this run as a comparison-lane sibling of the existing family (same ticket, same family ID, new variant tag). Use when you want to A/B compare runner/model/template changes against a prior run for the same bug.',
    });
  }
  actions.push({
    id: 'abort',
    label: 'Abort run',
    style: 'danger',
    description:
      'Cancels the current dispatch without touching existing task dirs. Use when the collision was unexpected and you need to investigate the prior runs before re-dispatching.',
  });
  return actions;
}

function autoResolveEngineDecision(
  run: Run,
  reason: string,
  actions: Array<{ id: string; label: string; style: 'primary' | 'secondary' | 'danger' }>,
): string | null {
  const ids = new Set(actions.map((a) => a.id));
  if (reason === 'collision' && ids.has('create-new')) {
    return collisionAutoResolveAction(run);
  }
  if (run.mode !== 'validation' && run.mode !== 'autonomous') return null;
  if (reason === 'review_posting' && ids.has('dismiss')) return 'dismiss';
  if (reason === 'human_gate') {
    // Publication-approval runs must wait for a human decision — never auto-resolve.
    // The evidence-refresh override is publication-only, so it is unreachable
    // here by construction (the early return above fires first); it is still
    // recognized as an approval everywhere a human resolves the gate.
    if (requiresPublicationApproval(run)) return null;
    if (ids.has('approve-publish')) return 'approve-publish';
    if (ids.has('ready')) return 'ready';
    if (ids.has('dismiss')) return 'dismiss';
    if (ids.has('hold')) return 'hold';
  }
  if (reason === 'self_review_complete') {
    if (ids.has('skip')) return 'skip';
    if (ids.has('send_feedback')) return 'send_feedback';
  }
  // Auto-resolve recipe strategy in autonomous mode (checked by caller setting mode on Run)
  if (reason === 'recipe_strategy' && ids.has('accept')) return 'accept';
  return null;
}

/**
 * Shared collision-decision handler. Emits engine_collision with a list of prior runs
 * that own the colliding task dirs, and processes the operator's chosen action:
 *
 *   - 'abort': throws (run fails with "Aborted: task dir collision").
 *   - 'start-comparison': cancels current run, forks a comparison-lane sibling into
 *      the prior family, throws RedirectedError. The UI's prior-runs panel offers
 *      per-row deep-links for operators who want to retry on a specific prior run.
 *   - 'create-new': returns 'create-new' so the caller can retry the task write
 *      with `skipCollisionCheck: true`.
 *
 * Called from both the pre-FIND_SLOT precheck (to avoid LLM cost when collision is
 * already certain) and the WRITE_TASK error path (defense-in-depth + race window).
 * createEngineDecision replays a resolved decision only when canReplayCollisionDecision
 * says the set of colliding dirs is unchanged; a new dir between precheck and WRITE_TASK
 * forces a fresh prompt so the operator sees the updated state.
 */
export async function handleCollisionDecision(
  runId: string,
  current: Run,
  existingDirs: string[],
  ticketSlug: string,
): Promise<'create-new'> {
  // Project-scoped lookup — two different projects can legitimately produce
  // task dir basenames with the same prefix (same slug schema, different repos).
  // Without the project filter a same-named dir in another project becomes the
  // owning run, and start-comparison would fork into the wrong family.
  const { runs: allRuns } = listRuns({});
  const candidates = allRuns
    .filter(
      (r) =>
        r.project === current.project &&
        r.taskFile != null &&
        existingDirs.some((dir) => r.taskFile!.includes(`/${dir}/`)),
    )
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  // First match per dir wins (already newest-first by sort) so dirOwners stays
  // deterministic and the UI's chip link is stable across renders. Early-exit
  // once every dir has an owner to avoid walking the long tail of candidates.
  const dirOwners: Record<string, string> = {};
  for (const r of candidates) {
    for (const dir of existingDirs) {
      if (dirOwners[dir]) continue;
      if (r.taskFile!.includes(`/${dir}/`)) dirOwners[dir] = r.id;
    }
    if (Object.keys(dirOwners).length === existingDirs.length) break;
  }
  // `candidates` is already sourced from `allRuns.filter(...)` (each id appears
  // at most once) and sorted newest-first; no dedup pass required.
  const priorRuns = candidates;
  const priorRunIds = priorRuns.map((r) => r.id);

  // Bulk actions only — to retry on a specific prior run the operator clicks the
  // per-row deep link in the UI panel. A bulk "continue-existing" button would be
  // ambiguous when multiple prior runs collide; the panel makes the choice explicit.
  const actions = collisionDecisionActions(current);

  const actionId = await createEngineDecision(
    runId,
    'collision',
    `Task dir collision for ${ticketSlug}: ${existingDirs.join(', ')}`,
    actions,
    { kind: 'collision', ticketSlug, existingDirs, priorRunIds, dirOwners },
    { canReplay: (prior) => canReplayCollisionDecision(prior, existingDirs) },
  );

  if (actionId === 'abort') throw new Error('Aborted: task dir collision');

  if (actionId === 'start-comparison') {
    const owningRun = priorRuns[0];
    const familyId = owningRun?.familyId ?? current.familyId;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const hhmmss = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const variant = current.variant
      ? `${current.variant}-collision-${hhmmss}`
      : `collision-${hhmmss}`;
    const priorStatus = getRun(runId)?.status ?? current.status;
    // Cancel first so assertDuplicateRunAllowed does not see an active production run.
    updateRun(runId, {
      status: 'cancelled',
      completedAt: new Date().toISOString(),
    });
    // Lazy import breaks the run-engine ↔ methods/run circular dep.
    const { runCreate } = await import('../methods/run.js');
    // Omit branch so applyComparisonBranchPolicy derives one for the collision-suffixed
    // variant. Carrying current.branch breaks when the variant gains a -collision- suffix.
    let successor;
    try {
      successor = await runCreate(
        {
          project: current.project,
          flowType: current.flowType,
          ticketOrPr: current.ticketOrPr,
          ticketData: current.ticketData,
          mode: current.mode,
          familyId,
          lane: 'comparison',
          variant,
          runner: current.metrics?.runner ?? undefined,
          model: current.metrics?.model ?? undefined,
          effort: current.effort,
          safetyTier: current.safetyTier,
          app: current.app,
          prNumber: hasValidPrNumber(current) ? current.prNumber : undefined,
          parentRunId: current.id,
          backlogItemId: current.backlogItemId,
          // Carry the operator's slot filter into the fork — without this the
          // comparison sibling would land on any project slot, escaping the
          // machine/slot scope that filtered the original dispatch.
          allowedSlots:
            current.allowedSlots && current.allowedSlots.length > 0
              ? [...current.allowedSlots]
              : undefined,
        },
        broadcastFn,
      );
    } catch (err) {
      updateRun(runId, { status: priorStatus, completedAt: undefined });
      broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
      throw err;
    }
    updateRun(runId, { redirectedToRunId: successor.run.id });
    broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });
    throw new RedirectedError(
      successor.run.id,
      `Redirected to comparison lane (successor: ${successor.run.id})`,
    );
  }

  return 'create-new';
}

export async function createEngineDecision(
  runId: string,
  reason: string,
  description: string,
  actions: DecisionAction[],
  payload?: RunDecisionPayload,
  options?: {
    /** Optional payload-aware dedup predicate. When provided, an existing resolved
     * decision of this reason is only replayed if `canReplay(existing)` is true.
     * Used by callers whose payload contents materially change the operator's
     * choice (e.g. engine_collision must re-prompt if a new colliding dir appeared
     * between precheck and WRITE_TASK). Without this hook, dedup keys on
     * reason+resolvedAt only and silently replays the prior action against new data. */
    canReplay?: (existing: RunDecision) => boolean;
  },
): Promise<string> {
  const run = getRun(runId);
  if (!run) throw new Error('Run not found');

  // Dedup: if a resolved decision matching `engine_${reason}` exists, return its
  // action instead of re-prompting. findLatestResolvedDecision walks newest-first
  // so a new decision appended after a canReplay-rejected prior one drives replay
  // semantics. Callers that need payload-aware dedup pass `canReplay`.
  const existing =
    reason === 'human_gate'
      ? latestResolvedHumanGateDecision(run.decisions)
      : findLatestResolvedDecision(run.decisions, reason);
  if (existing) {
    const replayableHumanGateDecision =
      reason === 'human_gate' && isReplayableResolvedHumanGateDecision(existing, actions);
    const replayAllowed = options?.canReplay ? options.canReplay(existing) : true;
    const resolvedAction = existing.resolvedAction;
    const actionStillOffered =
      !!resolvedAction && actions.some((action) => action.id === resolvedAction);
    if (
      replayAllowed &&
      actionStillOffered &&
      (reason !== 'human_gate' || replayableHumanGateDecision)
    ) {
      return resolvedAction!;
    }
  }

  const decision: RunDecision = {
    id: randomUUID(),
    type: `engine_${reason}`,
    title: `${run.ticketOrPr || `Run ${runId.slice(0, 8)}`} — ${reason.replace(/_/g, ' ')}`,
    description,
    actions,
    createdAt: new Date().toISOString(),
    ...(payload ? { payload } : {}),
  };

  run.decisions.push(decision);
  updateRun(runId, { status: 'blocked', decisions: run.decisions });
  broadcastFn(Events.RUN_DECISION_NEW, { runId, decision, slotId: run.slotId });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

  const autoAction = autoResolveEngineDecision(run, reason, actions);
  if (autoAction) {
    console.warn(
      `[run-engine] validation mode auto-resolved ${reason} for run ${runId.slice(0, 8)} -> ${autoAction}`,
    );
  }
  const actionId =
    autoAction ??
    (await new Promise<string>((resolve) => {
      engineDecisionResolvers.set(decision.id, resolve);
    }));

  decision.resolvedAt = new Date().toISOString();
  decision.resolvedAction = actionId;
  // Restore the pre-blocked status based on current step
  const currentStep = run.steps.find((s) => s.status === 'running');
  const restoredStatus = currentStep ? (stepToStatus[currentStep.name] ?? 'created') : 'created';
  updateRun(runId, { status: restoredStatus, decisions: run.decisions });
  broadcastFn(Events.RUN_DECISION_RESOLVED, { runId, decisionId: decision.id, actionId });
  broadcastFn(Events.RUN_UPDATED, { run: getRun(runId) });

  return actionId;
}
