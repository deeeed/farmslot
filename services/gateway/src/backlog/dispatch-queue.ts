// dispatch-queue.ts — In-memory queue + JSON file persistence
// Items persist across gateway restarts. Auto-dispatches when slots free up.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type DispatchQueueUpdateParams,
  isTerminalRunStatus,
  normalizeRunTags,
  type PressureAdmissionDecision,
  type QueueClaim,
  type QueueItem,
  type Run,
  type SlotStatus,
} from '@farmslot/protocol';

import type { InternalDispatchQueueAddParams } from '../core/queue-types.js';
import { evalSuiteCapUsage } from '../evals/suite-cap-store.js';
import { farmslotRoot, loadFleetStatus } from '../fleet/state.js';
import {
  capturePressureAdmissionDecisionsLightweight,
  isFreeSlot,
  parkPreservedSlotIds,
  resolveDispatchPreviewFromFleet,
} from '../methods/dispatch.js';
import { isStartRefPolicyError, normalizeStartRefRequest } from '../projects/start-ref-policy.js';
import { discardUndurableRun, getAllRuns, getRun, runRecordPath } from '../runs/store.js';
import type { WorkOriginator } from '../security/work-originator.js';

export type QueueRecord = QueueItem & { originator?: WorkOriginator };

function setQueueOriginator(record: QueueRecord, originator: WorkOriginator): void {
  Object.defineProperty(record, 'originator', {
    value: structuredClone(originator),
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

function shouldUseIsolatedQueueFile(env: NodeJS.ProcessEnv, argv: readonly string[]): boolean {
  if (env.FARMSLOT_TEST_TMP === '1' || env.NODE_TEST_CONTEXT) return true;
  return argv.some((arg) => /(?:^|[/\\])[^/\\]+\.test\.(?:ts|tsx|js|mjs|cjs)$/.test(arg));
}

function resolveQueueFile(): string {
  if (process.env.FARMSLOT_DISPATCH_QUEUE_FILE) return process.env.FARMSLOT_DISPATCH_QUEUE_FILE;
  if (shouldUseIsolatedQueueFile(process.env, process.argv)) {
    return path.join(os.tmpdir(), `farmslot-test-dispatch-queue-${process.pid}.json`);
  }
  return path.join(farmslotRoot, '.dispatch-queue.json');
}

const QUEUE_FILE = resolveQueueFile();
const queue: QueueRecord[] = [];
const QUEUE_PROVENANCE_MARKER = `${QUEUE_FILE}.provenance-v1`;
let queuePersistChain: Promise<void> = Promise.resolve();

/** Default exclusive-claim TTL. Holders must re-validate before createRun. */
export const DEFAULT_QUEUE_CLAIM_TTL_MS = 60_000;

type BroadcastFn = (event: string, payload: unknown) => void;
/** createAndStartRun receives the exclusive claim so it can re-validate at the
 * synchronous createRun boundary after its own awaits (imports, ticket fetch, …). */
export type CreateAndStartRunFn = (item: QueueRecord, claim: QueueClaim) => Promise<void>;
let _broadcast: BroadcastFn | null = null;
let _createAndStartRun: CreateAndStartRunFn | null = null;
let dispatchInFlight: Promise<void> | null = null;

/** Thrown when a holder loses exclusive ownership before durable run creation. */
export class QueueClaimLostError extends Error {
  readonly claim: QueueClaim;
  constructor(claim: QueueClaim, phase: string) {
    super(
      `Queue claim lost for ${claim.itemId.slice(0, 8)} at ${phase}; stopping before createRun`,
    );
    this.name = 'QueueClaimLostError';
    this.claim = claim;
  }
}

function clearClaimFields(item: QueueItem): void {
  item.claimHolder = undefined;
  item.claimExpiresAt = undefined;
  // claimEpoch is retained so the next claim still bumps past any prior token.
}

/** Holder + epoch still match (ignore wall-clock TTL). Unchanged epoch ⇒ nobody took over. */
function claimOwnershipMatches(item: QueueItem, claim: QueueClaim): boolean {
  if (item.id !== claim.itemId) return false;
  if (item.status !== 'dispatching') return false;
  if (item.claimHolder !== claim.holderId) return false;
  if ((item.claimEpoch ?? 0) !== claim.epoch) return false;
  return true;
}

function claimStillHeld(item: QueueItem, claim: QueueClaim, nowMs = Date.now()): boolean {
  if (!claimOwnershipMatches(item, claim)) return false;
  if (!item.claimExpiresAt || Date.parse(item.claimExpiresAt) <= nowMs) return false;
  return true;
}

export function initDispatchQueue(
  broadcast: BroadcastFn,
  createAndStartRun: CreateAndStartRunFn,
): void {
  _broadcast = broadcast;
  _createAndStartRun = createAndStartRun;
}

/**
 * Re-validate exclusive ownership immediately before durable run creation.
 * Call after every await inside createAndStartRun that precedes createRun /
 * evalTrialStart — a concurrent cancel/replay revokes the claim and must stop
 * a detached callback from creating a second run for the same node.
 *
 * Wall-clock TTL expiry alone is not takeover: if holder+epoch still match we
 * renew the claim and proceed. That avoids a permanent retry cliff when pre-create
 * work (project vars, remote branch probe, …) exceeds DEFAULT_QUEUE_CLAIM_TTL_MS
 * with no competitor. reclaimExpiredClaims still frees truly stranded claims.
 */
export function assertQueueClaimHeld(claim: QueueClaim, phase = 'pre-createRun'): void {
  if (!renewQueueClaim(claim)) {
    throw new QueueClaimLostError(claim, phase);
  }
}

/**
 * Reset expired dispatching claims back to `queued` so a crashed/slow
 * dispatcher cannot permanently strand a row until gateway restart.
 */
export function reclaimExpiredClaims(nowMs = Date.now()): number {
  let reclaimed = 0;
  let dropped = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i];
    if (!item || item.status !== 'dispatching') continue;
    // Handoff already produced a Run: never reclaim/requeue even if the claim TTL
    // expired mid-persist. Drop the row when the stamped run still exists.
    if (item.runId) {
      const stamped = getRun(item.runId);
      if (stamped) {
        queue.splice(i, 1);
        dropped += 1;
        continue;
      }
    }
    if (item.claimExpiresAt && Date.parse(item.claimExpiresAt) > nowMs) continue;
    // Missing expiresAt is treated as expired: a claim without TTL is invalid.
    item.status = 'queued';
    item.runId = undefined;
    item.claimEpoch = (item.claimEpoch ?? 0) + 1;
    clearClaimFields(item);
    reclaimed += 1;
  }
  if (reclaimed > 0 || dropped > 0) {
    schedulePersist('reclaim-expired');
    broadcastQueue();
  }
  return reclaimed + dropped;
}

function normalizedTrialSuffix(trialId: string): string {
  return trialId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[_.-]+|[_.-]+$/g, '')
    .slice(0, 40);
}

function runMatchesEvalQueueCell(runTrialId: string | undefined, cellTrialId: string): boolean {
  // evalTrialStart normalizes an explicit UI cell trial id into a stable
  // trialIdFor(...) suffix. Reconcile the persisted queue through that suffix
  // so a gateway restart does not relaunch an already-created eval run.
  if (!runTrialId) return false;
  if (runTrialId === cellTrialId) return true;
  const suffix = normalizedTrialSuffix(cellTrialId);
  return Boolean(suffix) && runTrialId.endsWith(`-${suffix}`);
}

// ─── Persistence ───

async function persist(): Promise<void> {
  // Atomic write: tmp + rename so a crash mid-write cannot leave a truncated
  // queue file that drops items on restart.
  const tmpPath = `${QUEUE_FILE}.tmp.${process.pid}.${randomUUID().slice(0, 8)}`;
  const storedQueue = queue.map((item) => ({
    ...item,
    ...(item.originator ? { originator: item.originator } : {}),
  }));
  await writeFile(tmpPath, JSON.stringify(storedQueue, null, 2), 'utf-8');
  await rename(tmpPath, QUEUE_FILE);
}

function enqueuePersist(reason: string): Promise<void> {
  queuePersistChain = queuePersistChain
    .catch(() => undefined)
    .then(() => persist())
    .catch((err) => {
      console.error(`[dispatch-queue] persist failed after ${reason}: ${(err as Error).message}`);
      throw err;
    });
  return queuePersistChain;
}

function schedulePersist(reason: string): void {
  enqueuePersist(reason).catch(() => undefined);
}

export async function persistQueueNow(): Promise<void> {
  await enqueuePersist('explicit');
}

/** Non-terminal run that already owns this queue handoff identity (restart reconcile). */
function findNonTerminalHandoffOwner(item: QueueItem): Run | undefined {
  return getAllRuns().find((run) => {
    if (isTerminalRunStatus(run.status)) return false;
    if (
      item.workGraphId &&
      item.workNodeId &&
      run.workGraphId === item.workGraphId &&
      run.workNodeId === item.workNodeId
    ) {
      // Launch-plan siblings share graph/node; require matching candidate when present.
      // Attempt rules (non-terminal runs only — terminal priors still allow true retries):
      // - equal attempt (including both undefined) → drop (handoff complete)
      // - both defined and unequal (N live vs N+1 row) → drop (revive/drop crash)
      // - mixed defined/undefined → keep row (legacy restart matrix)
      if (item.launchCandidateId) {
        if (
          run.launchCandidateId !== item.launchCandidateId ||
          run.launchPlanId !== item.launchPlanId
        ) {
          return false;
        }
        if (run.launchAttempt === item.launchAttempt) return true;
        return run.launchAttempt !== undefined && item.launchAttempt !== undefined;
      }
      return !run.launchCandidateId;
    }
    if (item.backlogItemId && run.backlogItemId === item.backlogItemId) {
      if (item.launchCandidateId) {
        if (
          run.launchCandidateId !== item.launchCandidateId ||
          run.launchPlanId !== item.launchPlanId
        ) {
          return false;
        }
        if (run.launchAttempt === item.launchAttempt) return true;
        return run.launchAttempt !== undefined && item.launchAttempt !== undefined;
      }
      return !run.launchCandidateId;
    }
    return false;
  });
}

export async function loadQueue(
  legacyOriginator: WorkOriginator = { kind: 'principal', principalId: 'local-admin' },
): Promise<void> {
  queue.length = 0;
  try {
    const raw = await readFile(QUEUE_FILE, 'utf-8');
    const items: QueueRecord[] = JSON.parse(raw);
    const migrationOpen = !existsSync(QUEUE_PROVENANCE_MARKER);
    let migrated = 0;
    for (const item of items) {
      const { originator: storedOriginator, ...publicItem } = item;
      const normalized: QueueRecord = {
        ...publicItem,
        queueKind: item.queueKind ?? 'dispatch',
      };
      if (storedOriginator) setQueueOriginator(normalized, storedOriginator);
      else if (migrationOpen) setQueueOriginator(normalized, legacyOriginator);
      if (migrationOpen && !item.originator) migrated += 1;
      if (normalized.status === 'queued') {
        // Crash after create/revive can leave a still-queued disk row while a
        // live Run already owns the work — drop rather than double-dispatch.
        const liveOwner = findNonTerminalHandoffOwner(normalized);
        if (liveOwner) {
          console.log(
            `[dispatch-queue] reconciled queued item ${normalized.id.slice(0, 8)} to existing run ${liveOwner.id.slice(0, 8)}`,
          );
          continue;
        }
        queue.push(normalized);
        continue;
      }
      if (normalized.status === 'dispatching') {
        // Handoff already completed: row carries runId for a Run that exists
        // (live or already terminal). Never requeue completed handoffs — a
        // terminal stamped run means create finished and the work already ran.
        if (normalized.runId) {
          const stamped = getAllRuns().find((run) => run.id === normalized.runId);
          if (stamped) {
            console.log(
              `[dispatch-queue] reconciled dispatching item ${normalized.id.slice(0, 8)} to stamped run ${stamped.id.slice(0, 8)} (status=${stamped.status})`,
            );
            continue;
          }
        }
        if (normalized.queueKind === 'eval-cell' && normalized.evalCell) {
          const evalCell = normalized.evalCell;
          const matchingRun = getAllRuns().find((run) => {
            const evalState = run.engineState?.evalExperiment;
            return (
              runMatchesEvalQueueCell(evalState?.trialId, evalCell.trialId) &&
              evalState?.capGroupId === evalCell.capGroupId
            );
          });
          if (matchingRun) {
            console.log(
              `[dispatch-queue] reconciled dispatching eval item ${normalized.id.slice(0, 8)} to run ${matchingRun.id.slice(0, 8)}`,
            );
            continue;
          }
        }
        if (normalized.backlogItemId && normalized.launchPlanId && normalized.launchCandidateId) {
          // A launch-candidate row's run carries the row's launchAttempt. If that
          // run already exists, the dequeue -> run handoff completed before
          // shutdown: drop the row, or a re-dispatch would create a second run
          // with the SAME attempt and equal-attempt observations would alternate
          // candidate ownership. Strict attempt equality keeps a
          // genuine retry row (higher attempt than an old terminal run) alive;
          // undefined === undefined covers legacy rows/runs without attempts.
          const matchingRun = getAllRuns().find(
            (run) =>
              run.backlogItemId === normalized.backlogItemId &&
              run.launchPlanId === normalized.launchPlanId &&
              run.launchCandidateId === normalized.launchCandidateId &&
              run.launchAttempt === normalized.launchAttempt,
          );
          if (matchingRun) {
            console.log(
              `[dispatch-queue] reconciled dispatching launch-candidate item ${normalized.id.slice(0, 8)} to run ${matchingRun.id.slice(0, 8)}`,
            );
            continue;
          }
        }
        // Ordinary backlog / work-graph / direct queue rows: match a non-terminal
        // run that already owns this handoff so restart does not requeue work that
        // finished create before the queue row was dropped.
        const ordinaryMatch = findNonTerminalHandoffOwner(normalized);
        if (ordinaryMatch) {
          console.log(
            `[dispatch-queue] reconciled dispatching item ${normalized.id.slice(0, 8)} to existing run ${ordinaryMatch.id.slice(0, 8)}`,
          );
          continue;
        }
        // Gateway shutdown between dequeue and run creation leaves no durable
        // run to reconcile, so reset the item and let normal queue dispatch try
        // again instead of dropping it on restart. Clear any stale claim so a
        // fresh claimQueueItem is required.
        normalized.status = 'queued';
        normalized.runId = undefined;
        clearClaimFields(normalized);
        queue.push(normalized);
      }
    }
    console.log(`[dispatch-queue] loaded ${queue.length} queued items from disk`);
    if (migrationOpen) {
      await persist();
      await writeFile(QUEUE_PROVENANCE_MARKER, 'provenance-v1\n', 'utf8');
      console.log(`[provenance] dispatch queue migrated ${migrated} item(s)`);
    }
    schedulePersist('load-reconcile');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !existsSync(QUEUE_PROVENANCE_MARKER)) {
      await mkdir(path.dirname(QUEUE_PROVENANCE_MARKER), { recursive: true });
      await writeFile(QUEUE_PROVENANCE_MARKER, 'provenance-v1\n', 'utf8');
      console.log('[provenance] dispatch queue migrated 0 item(s)');
    } else if (code !== 'ENOENT') {
      console.warn(`[dispatch-queue] failed to load queue: ${(err as Error).message}`);
    }
  }
}

// ─── Public API ───

function assertAllowedSlots(allowedSlots: string[] | null | undefined, action: string): void {
  if (Array.isArray(allowedSlots) && allowedSlots.length === 0) {
    throw new Error(`Cannot ${action}: active slot filters resolved to no matching slots`);
  }
}

function normalizeAllowedSlots(allowedSlots: string[] | null | undefined): string[] | null {
  return Array.isArray(allowedSlots) && allowedSlots.length > 0 ? [...allowedSlots] : null;
}

function assertEvalQueueItem(params: InternalDispatchQueueAddParams): void {
  if ((params.queueKind ?? 'dispatch') !== 'eval-cell') return;
  const cell = params.evalCell;
  if (!cell?.capGroupId?.trim()) throw new Error('Cannot queue eval cell: missing capGroupId');
  if (!cell.cellId?.trim()) throw new Error('Cannot queue eval cell: missing cellId');
  if (!cell.experimentManifestPath?.trim())
    throw new Error('Cannot queue eval cell: missing experimentManifestPath');
  if (!cell.trialId?.trim()) throw new Error('Cannot queue eval cell: missing trialId');
  if (!cell.trialStartParams || typeof cell.trialStartParams !== 'object')
    throw new Error('Cannot queue eval cell: missing trialStartParams');
}

export function addItem(
  params: InternalDispatchQueueAddParams,
  originator: WorkOriginator,
): QueueItem {
  assertAllowedSlots(params.allowedSlots, 'queue dispatch');
  assertEvalQueueItem(params);
  if (params.backlogItemId && params.launchPlanId && params.launchCandidateId) {
    const existing = queue.find(
      (item) =>
        item.backlogItemId === params.backlogItemId &&
        item.launchPlanId === params.launchPlanId &&
        item.launchCandidateId === params.launchCandidateId,
    );
    if (existing) return publicQueueItem(existing);
    const existingRun = getAllRuns().find(
      (run) =>
        run.backlogItemId === params.backlogItemId &&
        run.launchPlanId === params.launchPlanId &&
        run.launchCandidateId === params.launchCandidateId,
    );
    if (existingRun && !isTerminalRunStatus(existingRun.status)) {
      throw new Error(
        `Launch candidate ${params.launchCandidateId} already has active run ${existingRun.id}`,
      );
    }
  }
  const startRef = normalizeStartRefRequest(params);
  const tags = normalizeRunTags(params.tags);
  const item: QueueRecord = {
    id: randomUUID(),
    queueKind: params.queueKind ?? 'dispatch',
    backlogItemId: params.backlogItemId,
    workGraphId: params.workGraphId,
    workNodeId: params.workNodeId,
    launchPlanId: params.launchPlanId,
    launchCandidateId: params.launchCandidateId,
    launchGroupId: params.launchGroupId,
    launchSlotPolicy: params.launchSlotPolicy,
    launchAttempt: params.launchAttempt,
    label: params.label,
    flowType: params.flowType,
    project: params.project,
    ticketOrPr: params.ticketOrPr,
    familyId: params.familyId,
    parentRunId: params.parentRunId ?? null,
    familyRootTicketOrPr: params.familyRootTicketOrPr,
    lane: params.lane,
    variant: params.variant ?? null,
    taskTemplate: params.taskTemplate ? { ...params.taskTemplate } : undefined,
    executionTemplateId: params.executionTemplateId,
    executionTemplate: params.executionTemplate ? { ...params.executionTemplate } : undefined,
    domain: params.domain,
    app: params.app,
    prepareProfile: params.prepareProfile,
    waitPolicy: params.waitPolicy,
    model: params.model,
    runner: params.runner,
    scripted: params.scripted,
    effort: params.effort,
    mode: params.mode,
    devInteractiveProfile: params.devInteractiveProfile,
    ...(tags.length > 0 ? { tags } : {}),
    initialContext: params.initialContext,
    ticketData: params.ticketData,
    devChecklist: params.devChecklist,
    slotId: params.slotId,
    allowedSlots: normalizeAllowedSlots(params.allowedSlots),
    branch: params.branch ?? null,
    completionPolicy: params.completionPolicy,
    startRef,
    reviewDepth: params.reviewDepth,
    reviewScope: params.reviewScope,
    reviewValidationDepth: params.reviewValidationDepth,
    pendingReviewPlan: params.pendingReviewPlan,
    evalCell: params.evalCell,
    priority: params.priority ?? 10,
    createdAt: new Date().toISOString(),
    status: 'queued',
  };
  setQueueOriginator(item, originator);
  queue.push(item);
  schedulePersist('add');
  console.log(
    `[dispatch-queue] added item ${item.id.slice(0, 8)} for ${item.project}/${item.ticketOrPr}`,
  );
  broadcastQueue();
  if (params.autoDispatch !== false) {
    tryDispatchNext().catch((err) => {
      console.error(`[dispatch-queue] auto-dispatch after add failed: ${(err as Error).message}`);
    });
  }
  return publicQueueItem(item);
}

function removeItemAtIndex(idx: number, reason: string): void {
  const [removed] = queue.splice(idx, 1);
  if (!removed) return;
  // Bump epoch so any holder still holding a token discovers the loss.
  removed.claimEpoch = (removed.claimEpoch ?? 0) + 1;
  clearClaimFields(removed);
  schedulePersist(reason);
  console.log(`[dispatch-queue] removed item ${removed.id.slice(0, 8)} (${reason})`);
  broadcastQueue();
}

/** Internal removal for backlog.dequeue and orphan reconciliation. */
export function removeQueueItemInternal(itemId: string, reason = 'internal-remove'): void {
  const idx = queue.findIndex((q) => q.id === itemId);
  if (idx < 0) throw new Error(`Queue item not found: ${itemId}`);
  removeItemAtIndex(idx, reason);
}

/**
 * Remove a queue row and await durable persist. Used by the claim handoff so
 * createRun is on disk and the queue drop is on disk before further awaits.
 * Returns false when the row was already gone.
 */
export async function removeQueueItemInternalNow(
  itemId: string,
  reason = 'internal-remove',
): Promise<boolean> {
  const idx = queue.findIndex((q) => q.id === itemId);
  if (idx < 0) return false;
  removeItemAtIndex(idx, reason);
  await persistQueueNow();
  return true;
}

/**
 * Stamp runId on a claimed/dispatching row immediately after createRun (in
 * memory + schedulePersist). Concurrent replay refuses reclaim when runId is
 * set. Prefer {@link stampQueueItemRunIdNow} on the queue handoff path so the
 * stamp is durable before the run file write.
 */
export function stampQueueItemRunId(itemId: string, runId: string): void {
  const item = queue.find((q) => q.id === itemId);
  if (!item) return;
  item.runId = runId;
  schedulePersist('stamp-run-id');
}

/**
 * Stamp runId and await durable queue persist. Used by the claim handoff so a
 * crash between createRun and run-file persist still leaves a stamped row that
 * restart reconciliation can drop against the (possibly still-writing) Run.
 */
export async function stampQueueItemRunIdNow(itemId: string, runId: string): Promise<void> {
  const item = queue.find((q) => q.id === itemId);
  if (!item) {
    throw new Error(
      `stampQueueItemRunIdNow: queue item ${itemId.slice(0, 8)} missing — cannot stamp run ${runId.slice(0, 8)}`,
    );
  }
  item.runId = runId;
  await persistQueueNow();
}

export function removeItem(itemId: string): void {
  const idx = queue.findIndex((q) => q.id === itemId);
  if (idx < 0) throw new Error(`Queue item not found: ${itemId}`);
  if (queue[idx]?.backlogItemId) {
    throw new Error('Cannot remove backlog-linked queue item directly; use backlog.dequeue');
  }
  removeItemAtIndex(idx, 'remove');
}

// ─── Exclusive claim protocol (MANUAL-000053) ───

export type QueueClaimMutateOptions = {
  ttlMs?: number;
  /**
   * Skip persist + broadcast. Used for transient claim/release while probing
   * slot eligibility (disk still resets dispatching-without-runId on load).
   */
  quiet?: boolean;
};

/**
 * Atomically claim a queued row for exclusive dispatch. Records holder + epoch
 * and transitions status to `dispatching`. Returns null when the row is gone,
 * already claimed, or otherwise not claimable.
 */
export function claimQueueItem(
  itemId: string,
  holderId: string,
  options?: QueueClaimMutateOptions,
): QueueClaim | null {
  if (!holderId.trim()) return null;
  const item = queue.find((q) => q.id === itemId);
  if (!item || item.status !== 'queued') return null;
  const now = Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_QUEUE_CLAIM_TTL_MS;
  const epoch = (item.claimEpoch ?? 0) + 1;
  const expiresAt = new Date(now + Math.max(1, ttlMs)).toISOString();
  item.status = 'dispatching';
  item.claimHolder = holderId;
  item.claimEpoch = epoch;
  item.claimExpiresAt = expiresAt;
  if (!options?.quiet) {
    schedulePersist('claim');
    broadcastQueue();
  }
  return { itemId, holderId, epoch, expiresAt };
}

/**
 * Extend claimExpiresAt for a still-owned claim (holder+epoch match).
 * Wall-clock expiry alone does not block renew — only a revoke/reclaim that
 * bumps epoch or clears the holder does. Memory-only by default (no
 * persist/broadcast per renewal). Returns the updated claim token, or null
 * when ownership is lost.
 */
export function renewQueueClaim(
  claim: QueueClaim,
  options?: { ttlMs?: number },
): QueueClaim | null {
  const item = queue.find((q) => q.id === claim.itemId);
  if (!item || !claimOwnershipMatches(item, claim)) return null;
  const ttlMs = options?.ttlMs ?? DEFAULT_QUEUE_CLAIM_TTL_MS;
  const expiresAt = new Date(Date.now() + Math.max(1, ttlMs)).toISOString();
  item.claimExpiresAt = expiresAt;
  claim.expiresAt = expiresAt;
  return { itemId: claim.itemId, holderId: claim.holderId, epoch: claim.epoch, expiresAt };
}

/**
 * Revoke-and-take exclusive ownership for replay soft-lock. Unlike
 * claimQueueItem (queued-only), this may take over a dispatching row that has
 * not yet stamped a live Run — matching prior hand-rolled soft-lock semantics.
 */
export function claimQueueItemForReplay(
  itemId: string,
  holderId: string,
  options?: QueueClaimMutateOptions,
): QueueClaim | null {
  if (!holderId.trim()) return null;
  const item = queue.find((q) => q.id === itemId);
  if (!item) return null;
  if (item.status !== 'queued' && item.status !== 'dispatching') return null;
  // Never steal a stamped handoff mid-create.
  if (item.runId) {
    const stamped = getRun(item.runId);
    if (stamped && !isTerminalRunStatus(stamped.status)) return null;
  }
  const now = Date.now();
  const ttlMs = options?.ttlMs ?? 120_000;
  const epoch = (item.claimEpoch ?? 0) + 1;
  const expiresAt = new Date(now + Math.max(1, ttlMs)).toISOString();
  item.status = 'dispatching';
  item.claimHolder = holderId;
  item.claimEpoch = epoch;
  item.claimExpiresAt = expiresAt;
  if (!options?.quiet) {
    schedulePersist('claim-replay');
    broadcastQueue();
  }
  return { itemId, holderId, epoch, expiresAt };
}

/** True when the live queue row still holds this exact claim and it has not expired. */
export function isQueueClaimHeld(claim: QueueClaim, nowMs = Date.now()): boolean {
  const item = queue.find((q) => q.id === claim.itemId);
  if (!item) return false;
  return claimStillHeld(item, claim, nowMs);
}

/**
 * Release a held claim back to `queued` so another dispatcher can try.
 * No-op (returns false) when the claim is already lost.
 * Ownership match is enough (wall-clock expiry alone does not block release).
 */
export function releaseQueueClaim(claim: QueueClaim, options?: { quiet?: boolean }): boolean {
  const item = queue.find((q) => q.id === claim.itemId);
  if (!item || !claimOwnershipMatches(item, claim)) return false;
  item.status = 'queued';
  item.runId = undefined;
  clearClaimFields(item);
  if (!options?.quiet) {
    schedulePersist('release-claim');
    broadcastQueue();
  }
  return true;
}

/**
 * Cancel a graph-linked queue row (queued or claimed/dispatching) and optionally
 * run a dependent mutation that must succeed with the removal.
 *
 * Commit order (so queue disk and dependent fail together from the caller's view):
 * 1. Detach from memory (revokes any claim).
 * 2. Await durable queue persist without the row.
 * 3. Run `commitDependent`.
 * 4. If dependent throws: restore the row, await re-persist, rethrow.
 *
 * A crash after step 2 and before step 3 leaves the queue without the row and
 * the dependent unapplied — restart does not re-dispatch a cancelled graph row.
 */
export async function cancelGraphQueuedItem(params: {
  workGraphId: string;
  workNodeId: string;
  reason: string;
  /**
   * Dependent mutation that must succeed after the queue removal is durable
   * (e.g. backlog needs-attention). Invoked after queue persist.
   */
  commitDependent?: (item: QueueItem) => void | Promise<void>;
}): Promise<boolean> {
  const idx = queue.findIndex(
    (item) =>
      (item.status === 'queued' || item.status === 'dispatching') &&
      item.workGraphId === params.workGraphId &&
      item.workNodeId === params.workNodeId,
  );
  if (idx < 0) return false;
  const candidate = queue[idx];
  // Handoff already won: create stamped a live Run. Do not tear down the row
  // (or its claim epoch) out from under the dispatcher that just created it.
  if (candidate?.runId) {
    const stamped = getRun(candidate.runId);
    if (stamped && !isTerminalRunStatus(stamped.status)) {
      console.log(
        `[dispatch-queue] skip cancel of ${candidate.id.slice(0, 8)}: stamped live run ${stamped.id.slice(0, 8)}`,
      );
      return false;
    }
  }
  const [item] = queue.splice(idx, 1);
  if (!item) return false;
  // Revoke claim so any in-flight dispatcher fails re-validation.
  item.claimEpoch = (item.claimEpoch ?? 0) + 1;
  clearClaimFields(item);

  // Durable removal first — if this throws, restore memory so the row is not lost.
  try {
    await enqueuePersist('graph-dependency-regressed');
  } catch (err) {
    item.status = 'queued';
    item.runId = undefined;
    clearClaimFields(item);
    queue.splice(Math.min(idx, queue.length), 0, item);
    broadcastQueue();
    throw err;
  }

  if (params.commitDependent) {
    try {
      await params.commitDependent(item);
    } catch (err) {
      // Dependent failed after durable remove: put the row back and re-persist
      // so queue and dependent agree (row present, dependent not applied).
      item.status = 'queued';
      item.runId = undefined;
      clearClaimFields(item);
      queue.splice(Math.min(idx, queue.length), 0, item);
      try {
        await enqueuePersist('graph-cancel-dependent-failed');
      } catch (persistErr) {
        broadcastQueue();
        throw new Error(
          `Dependent mutation failed (${(err as Error).message}) and restoring the queue row to disk also failed (${(persistErr as Error).message})`,
          { cause: err },
        );
      }
      broadcastQueue();
      throw err;
    }
  }

  console.log(
    `[dispatch-queue] cancelled graph queue item ${item.id.slice(0, 8)}: ${params.reason}`,
  );
  broadcastQueue();
  return true;
}

export function updateItem(
  params: DispatchQueueUpdateParams,
  originator: WorkOriginator,
): QueueItem {
  const item = queue.find((q) => q.id === params.itemId);
  if (!item) throw new Error(`Queue item not found: ${params.itemId}`);
  if (item.status !== 'queued') {
    throw new Error(`Cannot update queue item ${params.itemId}: item is ${item.status}`);
  }
  if (params.priority !== undefined) item.priority = params.priority;
  if (params.label !== undefined) item.label = params.label;
  if (params.slotId !== undefined) item.slotId = params.slotId ?? undefined;
  if (params.allowedSlots !== undefined) {
    assertAllowedSlots(params.allowedSlots, 'update queue dispatch');
    item.allowedSlots = normalizeAllowedSlots(params.allowedSlots);
  }
  setQueueOriginator(item, originator);
  schedulePersist('update');
  broadcastQueue();
  return publicQueueItem(item);
}

export function reorderItems(itemIds: string[], originator: WorkOriginator): QueueItem[] {
  const uniqueIds = [...new Set(itemIds)];
  if (uniqueIds.length !== itemIds.length)
    throw new Error('Cannot reorder queue: duplicate item ids');
  const queuedItems = listItems();
  const queuedIds = new Set(queuedItems.map((item) => item.id));
  for (const id of uniqueIds) {
    if (!queuedIds.has(id)) throw new Error(`Cannot reorder queue: queued item not found: ${id}`);
  }
  const submittedIds = new Set(uniqueIds);
  let submittedIndex = 0;
  const normalizedIds = queuedItems.map((item) =>
    submittedIds.has(item.id) ? uniqueIds[submittedIndex++] : item.id,
  );
  // Normalize into dense 10-point priority buckets after every drag reorder.
  // Manual numeric priority edits remain valid until the next explicit reorder.
  normalizedIds.forEach((id, index) => {
    const item = queue.find((candidate) => candidate.id === id);
    if (item?.status === 'queued') {
      item.priority = (index + 1) * 10;
      setQueueOriginator(item, originator);
    }
  });
  schedulePersist('reorder');
  broadcastQueue();
  return listItems();
}

function broadcastQueue(): void {
  _broadcast?.('queue.updated', { items: listItems() });
}

export function listItems(): QueueItem[] {
  return [...queue]
    .filter((q) => q.status === 'queued')
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt))
    .map(publicQueueItem);
}

export function getQueueSnapshot(): QueueRecord[] {
  return queue.map(cloneQueueRecord);
}

export function mutateQueueItemForTests(
  itemId: string,
  mutation: (item: QueueRecord) => void,
): QueueRecord {
  if (!shouldUseIsolatedQueueFile(process.env, process.argv)) {
    throw new Error('mutateQueueItemForTests is available only in an isolated test runtime');
  }
  const item = queue.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error(`Queue item not found: ${itemId}`);
  mutation(item);
  return cloneQueueRecord(item);
}

export function queueRecordOriginator(itemId: string): WorkOriginator | undefined {
  const originator = queue.find((item) => item.id === itemId)?.originator;
  return originator ? structuredClone(originator) : undefined;
}

function publicQueueItem(record: QueueRecord): QueueItem {
  return structuredClone(record);
}

function cloneQueueRecord(record: QueueRecord): QueueRecord {
  const clone: QueueRecord = structuredClone(record);
  if (record.originator) setQueueOriginator(clone, record.originator);
  return clone;
}

export function buildQueuePreviewParams(item: QueueItem) {
  // Mirror buildDispatchPreviewParamsForRun: PR-bound flows pass the head
  // branch as targetBranch so findBestSlot's stale-branch penalty flips into
  // a bonus for slots already on that branch. Without this, queued review-pr
  // / pr-complete items behaved differently from direct dispatches.
  const targetBranch =
    (item.flowType === 'review-pr' || item.flowType === 'pr-complete') && item.branch
      ? item.branch
      : undefined;
  return {
    slotId: item.slotId,
    project: item.project,
    flowType: item.flowType,
    ticketOrPr: item.ticketOrPr,
    familyId: item.familyId,
    lane: item.lane,
    variant: item.variant ?? null,
    mode: item.mode,
    domain: item.domain,
    executionTemplateId: item.executionTemplateId,
    app: item.app,
    prepareProfile: item.prepareProfile,
    // Forward the UI-resolved allow list so the dispatcher refuses to land the
    // queued run on a machine the operator explicitly filtered out.
    allowedSlots: item.allowedSlots ?? undefined,
    targetBranch,
  };
}

/**
 * Queue/slot resource gating uses explicit operator prepare only.
 * Profile-fit may advise in dispatch preview UI; it must never stamp queue items
 * or narrow free-slot eligibility (ADR-037 advisory-only follow-up).
 */
function requiredPrepareProfileForQueueItem(item: QueueItem): string | null {
  return item.prepareProfile ?? null;
}

/** Queue ticks always use the lightweight in-memory capture: no slot resource
 * resolution and no tmux/process attribution, ever. Deterministic tests stub
 * it. */
type QueuePressureCapture = (
  machines: string[],
) => Promise<Map<string, PressureAdmissionDecision>> | Map<string, PressureAdmissionDecision>;

const defaultQueuePressureCapture: QueuePressureCapture = (machines) =>
  capturePressureAdmissionDecisionsLightweight(machines);

let queuePressureCaptureImpl: QueuePressureCapture = defaultQueuePressureCapture;

export function setQueueDispatchPressureCaptureForTests(fn?: QueuePressureCapture): void {
  queuePressureCaptureImpl = fn ?? defaultQueuePressureCapture;
}

/**
 * True when the item has free project slots but every one of them sits on a
 * pressure-rejected machine. The queue holds the item (returns null from
 * selection) instead of letting the preview resolver throw and the tick treat
 * a policy decline as a dispatch failure.
 */
export function queueItemHeldByPressure(
  slots: readonly SlotStatus[],
  project: string,
  pressureDecisions: ReadonlyMap<string, PressureAdmissionDecision>,
  allowedSlots?: readonly string[] | null,
): boolean {
  // Scope to the exact allow list the resolver will see (item allowlist or
  // spread-policy subset). An admitted free slot outside it must not defeat
  // the hold while every allowed slot still resolves to a rejected machine.
  const allow = allowedSlots && allowedSlots.length > 0 ? new Set(allowedSlots) : null;
  const freeProjectSlots = slots.filter(
    (slot) => slot.project === project && isFreeSlot(slot) && (!allow || allow.has(slot.slot)),
  );
  if (freeProjectSlots.length === 0) return false;
  return freeProjectSlots.every(
    (slot) => pressureDecisions.get(slot.machine)?.outcome === 'rejected',
  );
}

export async function selectQueueDispatchSlot(
  slots: SlotStatus[],
  item: QueueItem,
  deps: { capturePressure?: QueuePressureCapture } = {},
): Promise<string | null> {
  const requiredPrepareProfile = requiredPrepareProfileForQueueItem(item);
  // ADR-054: the unattended queue is the path the spec is about, so it must
  // score a park-preserved slot the same way the interactive pickers do.
  const parkPreserved = parkPreservedSlotIds(getAllRuns());
  const capturePressure = deps.capturePressure ?? queuePressureCaptureImpl;
  // No dispatchable slot at all (ready/held, allowlist-scoped): stay queued
  // WITHOUT any pressure work. A tick over a fully busy fleet must stay
  // free. Pinned items keep the resolver's explicit-slot handling.
  const allow =
    item.allowedSlots && item.allowedSlots.length > 0 ? new Set(item.allowedSlots) : null;
  const eligibleSlots = slots.filter(
    (slot) =>
      slot.project === item.project &&
      canDispatchQueuedItemToSlot(slot) &&
      (!allow || allow.has(slot.slot)),
  );
  if (!item.slotId && eligibleSlots.length === 0) return null;
  // One lightweight pressure capture per selection pass; queued automatic
  // dispatch must exclude pressure-rejected machines exactly like FIND_SLOT.
  const pressureDecisions = await capturePressure([
    ...new Set(
      (item.slotId ? slots.filter((slot) => slot.project === item.project) : eligibleSlots).map(
        (slot) => slot.machine,
      ),
    ),
  ]);
  if (queueItemHeldByPressure(slots, item.project, pressureDecisions, item.allowedSlots)) {
    console.log(
      `[dispatch-queue] holding ${item.id} (${item.project}/${item.ticketOrPr}): every allowed free machine is pressure-rejected`,
    );
    return null;
  }
  if (item.launchSlotPolicy === 'spread' && item.launchGroupId) {
    const activeSiblingSlots = new Set(
      getAllRuns()
        .filter(
          (run) =>
            run.launchGroupId === item.launchGroupId &&
            run.id !== item.runId &&
            !isTerminalRunStatus(run.status) &&
            run.slotId,
        )
        .map((run) => run.slotId as string),
    );
    if (activeSiblingSlots.size > 0) {
      const allowed = (item.allowedSlots ?? slots.map((slot) => slot.slot)).filter(
        (slotId) => !activeSiblingSlots.has(slotId),
      );
      if (allowed.length > 0) {
        if (queueItemHeldByPressure(slots, item.project, pressureDecisions, allowed)) {
          console.log(
            `[dispatch-queue] holding ${item.id} (${item.project}/${item.ticketOrPr}): every spread-allowed free machine is pressure-rejected`,
          );
          return null;
        }
        const preview = resolveDispatchPreviewFromFleet(
          { ...buildQueuePreviewParams(item), allowedSlots: allowed },
          slots,
          undefined,
          { requiredPrepareProfile, pressureDecisions, parkPreservedSlotIds: parkPreserved },
        );
        if (preview.pressureAdmission?.outcome === 'rejected') return null;
        return preview.preview.slotId;
      }
    }
  }
  const preview = resolveDispatchPreviewFromFleet(buildQueuePreviewParams(item), slots, undefined, {
    requiredPrepareProfile,
    pressureDecisions,
    parkPreservedSlotIds: parkPreserved,
  });
  // A pinned queue item whose machine is pressure-rejected stays queued until
  // pressure recedes; automatic selection already excluded rejected machines.
  if (preview.pressureAdmission?.outcome === 'rejected') return null;
  return preview.preview.slotId;
}

// ─── Auto-dispatch ───

export function canDispatchQueuedItemToSlot(slot: SlotStatus): boolean {
  // Ghost slots (absent from live pools) fail run creation with SLOT_NOT_FOUND.
  if (slot.missingFromPool) return false;
  return slot.agent !== 'working' && (slot.lifecycle === 'ready' || slot.lifecycle === 'held');
}

export async function tryDispatchNext(): Promise<void> {
  if (dispatchInFlight) return dispatchInFlight;
  dispatchInFlight = tryDispatchNextOnce().finally(() => {
    dispatchInFlight = null;
  });
  return dispatchInFlight;
}

function isNonRetryableEvalQueueError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.startsWith('Invalid eval.trial.start params:') ||
    message.startsWith('Invalid candidate axes:') ||
    message.startsWith('Experiment manifest project mismatch:') ||
    message.startsWith('Existing trial has no package path:')
  );
}

function liveQueuedItem(itemId: string): QueueItem | null {
  const item = queue.find((candidate) => candidate.id === itemId);
  return item?.status === 'queued' ? item : null;
}

/** Backoff for claim-loss / retry loops so a slow uncontested path cannot spin. */
let dispatchRetryBackoffMs = 0;
const DISPATCH_RETRY_BACKOFF_MIN_MS = 250;
const DISPATCH_RETRY_BACKOFF_MAX_MS = 30_000;

function resetDispatchRetryBackoff(): void {
  dispatchRetryBackoffMs = 0;
}

function scheduleDispatchRetry(reason: string): void {
  // Must run after dispatchInFlight clears (tryDispatchNextOnce finally), or the
  // retry would join the finishing promise and no-op. setTimeout(0)/setImmediate
  // both work; delay grows on repeated retries (claim-loss cliffs, busy fleet).
  const delayMs = dispatchRetryBackoffMs;
  dispatchRetryBackoffMs =
    delayMs === 0
      ? DISPATCH_RETRY_BACKOFF_MIN_MS
      : Math.min(delayMs * 2, DISPATCH_RETRY_BACKOFF_MAX_MS);
  const runRetry = () => {
    tryDispatchNext().catch((err) => {
      console.error(
        `[dispatch-queue] retry after ${reason} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };
  if (delayMs <= 0) {
    setImmediate(runRetry);
  } else {
    setTimeout(runRetry, delayMs);
  }
}

function stopIfClaimLost(claim: QueueClaim, phase: string): boolean {
  // Renew if we still own holder+epoch (TTL alone is not takeover). Only a
  // revoke/reclaim that cleared ownership is a real claim loss.
  if (renewQueueClaim(claim)) return false;
  // Ownership lost — reclaim any stranded expired rows and retry with backoff.
  reclaimExpiredClaims();
  console.log(
    `[dispatch-queue] claim lost for ${claim.itemId.slice(0, 8)} after ${phase}; stopping before createRun`,
  );
  // Returning true ends this dispatch cycle (tryDispatchNextOnce returns).
  // Schedule another cycle so the reclaimed row (and siblings) get another try
  // without waiting for an external fleet/event trigger.
  scheduleDispatchRetry(`claim-loss-${phase}`);
  return true;
}

async function tryDispatchNextOnce(): Promise<void> {
  if (!_broadcast || !_createAndStartRun) return;

  // Expired claims leave status=dispatching but are no longer held — reset so
  // listItems can see them again without waiting for a gateway restart.
  reclaimExpiredClaims();

  const pending = listItems();
  if (pending.length === 0) return;

  const fleet = await loadFleetStatus();

  for (const pendingItem of pending) {
    const item = liveQueuedItem(pendingItem.id);
    if (!item) continue;
    if (item.queueKind === 'eval-cell' && item.evalCell) {
      const usage = evalSuiteCapUsage(item.evalCell.capGroupId, queue);
      if (usage.active + usage.dispatching >= usage.cap) {
        continue;
      }
    }

    // Claim exclusively before any further await that commits us to this row.
    // A concurrent cancel/reclaim revokes the claim; we re-validate after every
    // await and stop before createRun rather than acting on a detached object.
    // Quiet until slot eligibility is known — avoids 2N full-queue writes +
    // queue.updated events per tryDispatchNext tick when the fleet is busy.
    const holderId = `dispatch-${randomUUID()}`;
    const claim = claimQueueItem(item.id, holderId, { quiet: true });
    if (!claim) continue;

    let slot: SlotStatus | undefined;
    try {
      const slotId = await selectQueueDispatchSlot(fleet.slots, item);
      if (stopIfClaimLost(claim, 'slot-selection')) return;
      slot = fleet.slots.find((s) => s.slot === slotId);
    } catch (error) {
      releaseQueueClaim(claim, { quiet: true });
      console.debug(
        `[dispatch-queue] skipping queued item ${item.id.slice(0, 8)}: ${(error as Error).message}`,
      );
      continue;
    }

    if (!slot || !canDispatchQueuedItemToSlot(slot)) {
      releaseQueueClaim(claim, { quiet: true });
      continue;
    }
    if (stopIfClaimLost(claim, 'slot-eligibility')) return;

    item.slotId = slot.slot;
    // Promote the quiet claim: one durable write + broadcast for the real dispatch.
    renewQueueClaim(claim);
    schedulePersist('mark-dispatching');
    broadcastQueue();
    console.log(`[dispatch-queue] auto-dispatching ${item.id.slice(0, 8)} → slot ${slot.slot}`);

    // Re-validate + renew before entering createAndStartRun so long pre-create
    // work cannot expire an uncontested claim; callback re-validates again
    // immediately before the durable createRun / evalTrialStart call.
    if (!renewQueueClaim(claim)) {
      if (stopIfClaimLost(claim, 'pre-createAndStartRun')) return;
      return;
    }

    try {
      await _createAndStartRun(item, claim);
      resetDispatchRetryBackoff();
      // Defensive: createAndStartRun normally drops the row via removeQueueItemInternalNow
      // after durable create. If the callback did not drop it, remove here so a
      // successful handoff never leaves a dispatching row for requeue.
      const idx = queue.findIndex((q) => q.id === item.id);
      if (idx >= 0) {
        queue.splice(idx, 1);
        schedulePersist('auto-dispatch-success');
        _broadcast('queue.updated', { items: listItems() });
      }
    } catch (err) {
      if (err instanceof QueueClaimLostError) {
        console.log(`[dispatch-queue] ${err.message}`);
        reclaimExpiredClaims();
        scheduleDispatchRetry('queue-claim-lost-error');
        return;
      }
      if (
        isStartRefPolicyError(err) ||
        (item.queueKind === 'eval-cell' && isNonRetryableEvalQueueError(err))
      ) {
        // Defense-in-depth: addItem validates startRef and eval queue shape before
        // persistence, but queued JSON can outlive code changes or manual edits.
        // Cancel non-retryable items loudly instead of head-of-line retry loops.
        // Ownership match is enough (TTL alone is not takeover).
        if (renewQueueClaim(claim)) {
          item.status = 'cancelled';
          item.runId = undefined;
          clearClaimFields(item);
          schedulePersist(
            isStartRefPolicyError(err)
              ? 'auto-dispatch-start-ref-policy-failure'
              : 'auto-dispatch-eval-policy-failure',
          );
          console.error(
            `[dispatch-queue] cancelling invalid queued item ${item.id.slice(0, 8)}: ${(err as Error).message}`,
          );
          _broadcast('queue.updated', { items: listItems() });
        }
        return;
      }
      // createRun may have produced an in-memory Run and stamped runId before a
      // later await failed. Only drop the row when the Run is durable on disk —
      // otherwise requeue and purge the memory-only orphan so retry can create.
      if (item.runId) {
        const partial = getRun(item.runId);
        if (partial) {
          const durable = existsSync(runRecordPath(partial.id));
          if (durable) {
            const stillPresent = queue.some((q) => q.id === item.id);
            if (stillPresent) {
              await removeQueueItemInternalNow(item.id, 'dispatch-create-partial');
            }
            console.error(
              `[dispatch-queue] auto-dispatch partial create for ${item.id.slice(0, 8)} ` +
                `(durable run ${item.runId.slice(0, 8)} kept, queue row dropped): ${(err as Error).message}`,
            );
            return;
          }
          // Memory-only orphan: hard-discard (no analytics gate) so a retry
          // cannot leave a second Run in the map while the row is requeued.
          const orphanId = partial.id;
          await discardUndurableRun(orphanId);
          if (!releaseQueueClaim(claim) && queue.some((q) => q.id === item.id)) {
            item.status = 'queued';
            item.runId = undefined;
            clearClaimFields(item);
            schedulePersist('release-memory-only-create');
            broadcastQueue();
          }
          console.error(
            `[dispatch-queue] auto-dispatch memory-only create for ${item.id.slice(0, 8)} ` +
              `(orphan ${orphanId.slice(0, 8)} purged, row requeued): ${(err as Error).message}`,
          );
          return;
        }
      }
      // Revert to queued on failure when we still own the claim and no Run exists.
      releaseQueueClaim(claim);
      console.error(
        `[dispatch-queue] auto-dispatch failed for ${item.id.slice(0, 8)}: ${(err as Error).message}`,
      );
    }

    // Only dispatch one at a time per cycle
    return;
  }
}
