// dispatch-queue.ts — In-memory queue + JSON file persistence
// Items persist across gateway restarts. Auto-dispatches when slots free up.

import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type DispatchQueueUpdateParams,
  isTerminalRunStatus,
  normalizeRunTags,
  type QueueClaim,
  type QueueItem,
  type Run,
  type SlotStatus,
} from '@farmslot/protocol';

import type { InternalDispatchQueueAddParams } from '../core/queue-types.js';
import { evalSuiteCapUsage } from '../evals/suite-cap-store.js';
import { farmslotRoot, loadFleetStatus } from '../fleet/state.js';
import { resolveDispatchPreviewFromFleet } from '../methods/dispatch.js';
import { isStartRefPolicyError, normalizeStartRefRequest } from '../projects/start-ref-policy.js';
import { detectProfileFit } from '../run-engine/profile-fit-gate.js';
import { fetchTicketData } from '../run-engine/ticket-data.js';
import { getAllRuns } from '../runs/store.js';

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
const queue: QueueItem[] = [];
let queuePersistChain: Promise<void> = Promise.resolve();
const queueProfileFitCache = new Map<string, string | null>();
const queueProfileFitDeferUntil = new Map<string, number>();

/** Default exclusive-claim TTL. Holders must re-validate before createRun. */
export const DEFAULT_QUEUE_CLAIM_TTL_MS = 60_000;

type BroadcastFn = (event: string, payload: unknown) => void;
/** createAndStartRun receives the exclusive claim so it can re-validate at the
 * synchronous createRun boundary after its own awaits (imports, ticket fetch, …). */
export type CreateAndStartRunFn = (item: QueueItem, claim: QueueClaim) => Promise<void>;
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

function claimStillHeld(item: QueueItem, claim: QueueClaim, nowMs = Date.now()): boolean {
  if (item.id !== claim.itemId) return false;
  if (item.status !== 'dispatching') return false;
  if (item.claimHolder !== claim.holderId) return false;
  if ((item.claimEpoch ?? 0) !== claim.epoch) return false;
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
 */
export function assertQueueClaimHeld(claim: QueueClaim, phase = 'pre-createRun'): void {
  if (!isQueueClaimHeld(claim)) {
    throw new QueueClaimLostError(claim, phase);
  }
}

/**
 * Reset expired dispatching claims back to `queued` so a crashed/slow
 * dispatcher cannot permanently strand a row until gateway restart.
 */
export function reclaimExpiredClaims(nowMs = Date.now()): number {
  let reclaimed = 0;
  for (const item of queue) {
    if (item.status !== 'dispatching') continue;
    if (item.claimExpiresAt && Date.parse(item.claimExpiresAt) > nowMs) continue;
    // Missing expiresAt is treated as expired: a claim without TTL is invalid.
    item.status = 'queued';
    item.runId = undefined;
    item.claimEpoch = (item.claimEpoch ?? 0) + 1;
    clearClaimFields(item);
    reclaimed += 1;
  }
  if (reclaimed > 0) {
    schedulePersist('reclaim-expired');
    broadcastQueue();
  }
  return reclaimed;
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
  await writeFile(tmpPath, JSON.stringify(queue, null, 2), 'utf-8');
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

function queueProfileFitCacheKey(item: QueueItem): string {
  return [item.id, item.ticketOrPr, item.app ?? '', item.prepareProfile ?? '', item.createdAt].join(
    '\0',
  );
}

function clearQueueProfileFitCache(item: QueueItem): void {
  const prefix = `${item.id}\0`;
  for (const key of queueProfileFitCache.keys()) {
    if (key.startsWith(prefix)) queueProfileFitCache.delete(key);
  }
  for (const key of queueProfileFitDeferUntil.keys()) {
    if (key.startsWith(prefix)) queueProfileFitDeferUntil.delete(key);
  }
}

export async function persistQueueNow(): Promise<void> {
  await enqueuePersist('explicit');
}

export async function loadQueue(): Promise<void> {
  queue.length = 0;
  try {
    const raw = await readFile(QUEUE_FILE, 'utf-8');
    const items: QueueItem[] = JSON.parse(raw);
    for (const item of items) {
      const normalized: QueueItem = {
        ...item,
        queueKind: item.queueKind ?? 'dispatch',
      };
      if (normalized.status === 'queued') {
        queue.push(normalized);
        continue;
      }
      if (normalized.status === 'dispatching') {
        // Handoff already completed: row carries runId for a still-live run.
        if (normalized.runId) {
          const stamped = getAllRuns().find((run) => run.id === normalized.runId);
          if (stamped && !isTerminalRunStatus(stamped.status)) {
            console.log(
              `[dispatch-queue] reconciled dispatching item ${normalized.id.slice(0, 8)} to stamped run ${stamped.id.slice(0, 8)}`,
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
        const ordinaryMatch = getAllRuns().find((run) => {
          if (isTerminalRunStatus(run.status)) return false;
          if (
            normalized.workGraphId &&
            normalized.workNodeId &&
            run.workGraphId === normalized.workGraphId &&
            run.workNodeId === normalized.workNodeId
          ) {
            // Launch-plan siblings share graph/node; require matching candidate when present.
            if (normalized.launchCandidateId) {
              return (
                run.launchCandidateId === normalized.launchCandidateId &&
                run.launchPlanId === normalized.launchPlanId &&
                run.launchAttempt === normalized.launchAttempt
              );
            }
            return !run.launchCandidateId;
          }
          if (normalized.backlogItemId && run.backlogItemId === normalized.backlogItemId) {
            if (normalized.launchCandidateId) {
              return (
                run.launchCandidateId === normalized.launchCandidateId &&
                run.launchPlanId === normalized.launchPlanId &&
                run.launchAttempt === normalized.launchAttempt
              );
            }
            return !run.launchCandidateId;
          }
          return false;
        });
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
    schedulePersist('load-reconcile');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
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

export function addItem(params: InternalDispatchQueueAddParams): QueueItem {
  assertAllowedSlots(params.allowedSlots, 'queue dispatch');
  assertEvalQueueItem(params);
  if (params.backlogItemId && params.launchPlanId && params.launchCandidateId) {
    const existing = queue.find(
      (item) =>
        item.backlogItemId === params.backlogItemId &&
        item.launchPlanId === params.launchPlanId &&
        item.launchCandidateId === params.launchCandidateId,
    );
    if (existing) return existing;
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
  const item: QueueItem = {
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
    pendingReviewPlan: params.pendingReviewPlan,
    evalCell: params.evalCell,
    priority: params.priority ?? 10,
    createdAt: new Date().toISOString(),
    status: 'queued',
  };
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
  return item;
}

function removeItemAtIndex(idx: number, reason: string): void {
  const [removed] = queue.splice(idx, 1);
  if (!removed) return;
  // Bump epoch so any holder still holding a token discovers the loss.
  removed.claimEpoch = (removed.claimEpoch ?? 0) + 1;
  clearClaimFields(removed);
  clearQueueProfileFitCache(removed);
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
 * Stamp runId on a claimed/dispatching row immediately after createRun, before
 * awaitPersist. Concurrent replay refuses reclaim when runId is set; restart
 * reconciliation drops the row when the stamped run is still live.
 */
export function stampQueueItemRunId(itemId: string, runId: string): void {
  const item = queue.find((q) => q.id === itemId);
  if (!item) return;
  item.runId = runId;
  schedulePersist('stamp-run-id');
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

/**
 * Atomically claim a queued row for exclusive dispatch. Records holder + epoch
 * and transitions status to `dispatching`. Returns null when the row is gone,
 * already claimed, or otherwise not claimable.
 */
export function claimQueueItem(
  itemId: string,
  holderId: string,
  options?: { ttlMs?: number },
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
  schedulePersist('claim');
  broadcastQueue();
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
 */
export function releaseQueueClaim(claim: QueueClaim): boolean {
  const item = queue.find((q) => q.id === claim.itemId);
  if (!item || !claimStillHeld(item, claim)) return false;
  item.status = 'queued';
  item.runId = undefined;
  clearClaimFields(item);
  schedulePersist('release-claim');
  broadcastQueue();
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
  const [item] = queue.splice(idx, 1);
  if (!item) return false;
  // Revoke claim so any in-flight dispatcher fails re-validation.
  item.claimEpoch = (item.claimEpoch ?? 0) + 1;
  clearClaimFields(item);
  clearQueueProfileFitCache(item);

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

export function updateItem(params: DispatchQueueUpdateParams): QueueItem {
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
  schedulePersist('update');
  broadcastQueue();
  return item;
}

export function reorderItems(itemIds: string[]): QueueItem[] {
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
    if (item?.status === 'queued') item.priority = (index + 1) * 10;
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
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
}

export function getQueueSnapshot(): QueueItem[] {
  return [...queue];
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

async function requiredPrepareProfileForQueueItem(item: QueueItem): Promise<string | null> {
  if (item.prepareProfile) return item.prepareProfile;
  const cacheKey = queueProfileFitCacheKey(item);
  if (queueProfileFitCache.has(cacheKey)) {
    return queueProfileFitCache.get(cacheKey) ?? null;
  }
  const deferUntil = queueProfileFitDeferUntil.get(cacheKey);
  if (deferUntil && deferUntil > Date.now()) {
    throw new Error(
      `Ticket metadata unavailable for ${item.ticketOrPr}; retrying profile fit after ${new Date(deferUntil).toISOString()}`,
    );
  }
  if (item.project !== 'farmslot-farm') {
    queueProfileFitCache.set(cacheKey, null);
    return null;
  }
  const previewRun = {
    id: item.runId ?? item.id,
    familyId: item.familyId ?? item.id,
    lane: item.lane ?? 'production',
    flowType: item.flowType,
    status: 'created',
    project: item.project,
    ticketOrPr: item.ticketOrPr,
    slotId: item.slotId ?? null,
    branch: item.branch ?? null,
    taskFile: null,
    steps: [],
    decisions: [],
    metrics: { nudgeCount: 0, model: item.model ?? null, runner: item.runner ?? null },
    createdAt: item.createdAt,
    updatedAt: item.createdAt,
    prepareProfile: item.prepareProfile,
    app: item.app,
  } as Run;
  // Prefer the payload persisted at intake (manual backlog metadata is richer than
  // anything a re-fetch of a free-form ticket string can produce).
  let ticketData: Awaited<ReturnType<typeof fetchTicketData>> | null = item.ticketData ?? null;
  if (!ticketData) {
    try {
      ticketData = await fetchTicketData(previewRun);
    } catch {
      // Queue metadata can outlive network/GitHub availability; explicit app/profile still gate.
    }
  }
  // Strict ref shape only (`#123` / `owner/repo#123`): free-form titles that merely
  // contain '#' (e.g. "improve the #runs view") must not trigger metadata deferral.
  const githubRef = /^(?:[\w.-]+\/[\w.-]+)?#\d+$/.test(item.ticketOrPr.trim());
  const onlyFallbackTicketData =
    ticketData?.source === 'manual' &&
    ticketData.title === item.ticketOrPr &&
    !ticketData.description &&
    (ticketData.acceptanceCriteria?.length ?? 0) === 0 &&
    (ticketData.labels?.length ?? 0) === 0;
  if (githubRef && onlyFallbackTicketData) {
    queueProfileFitDeferUntil.set(cacheKey, Date.now() + 60_000);
    throw new Error(
      `Ticket metadata unavailable for ${item.ticketOrPr}; deferring queued dispatch so implicit profile fit cannot bind the wrong slot`,
    );
  }
  const profileFit = detectProfileFit(previewRun, ticketData, {
    prepareProfile: item.prepareProfile,
    app: item.app,
    slotPlatform: null,
  });
  const requiredPrepareProfile = profileFit?.suggestedPrepareProfile ?? null;
  queueProfileFitCache.set(cacheKey, requiredPrepareProfile);
  if (requiredPrepareProfile) {
    item.prepareProfile = requiredPrepareProfile;
    schedulePersist('profile-fit');
  }
  return requiredPrepareProfile;
}

export async function selectQueueDispatchSlot(
  slots: SlotStatus[],
  item: QueueItem,
): Promise<string | null> {
  const requiredPrepareProfile = await requiredPrepareProfileForQueueItem(item);
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
        const preview = resolveDispatchPreviewFromFleet(
          { ...buildQueuePreviewParams(item), allowedSlots: allowed },
          slots,
          undefined,
          { requiredPrepareProfile },
        );
        return preview.preview.slotId;
      }
    }
  }
  const preview = resolveDispatchPreviewFromFleet(buildQueuePreviewParams(item), slots, undefined, {
    requiredPrepareProfile,
  });
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

function stopIfClaimLost(claim: QueueClaim, phase: string): boolean {
  if (isQueueClaimHeld(claim)) return false;
  console.log(
    `[dispatch-queue] claim lost for ${claim.itemId.slice(0, 8)} after ${phase}; stopping before createRun`,
  );
  // Returning true ends this dispatch cycle (tryDispatchNextOnce returns).
  // Other queued rows are picked up on the next tryDispatchNext trigger —
  // intentional: one claim loss should not continue scanning under stale fleet.
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
    const holderId = `dispatch-${randomUUID()}`;
    const claim = claimQueueItem(item.id, holderId);
    if (!claim) continue;

    let slot: SlotStatus | undefined;
    try {
      const slotId = await selectQueueDispatchSlot(fleet.slots, item);
      if (stopIfClaimLost(claim, 'slot-selection')) return;
      slot = fleet.slots.find((s) => s.slot === slotId);
    } catch (error) {
      if (isQueueClaimHeld(claim)) releaseQueueClaim(claim);
      console.debug(
        `[dispatch-queue] skipping queued item ${item.id.slice(0, 8)}: ${(error as Error).message}`,
      );
      continue;
    }

    if (!slot || !canDispatchQueuedItemToSlot(slot)) {
      if (isQueueClaimHeld(claim)) releaseQueueClaim(claim);
      continue;
    }
    if (stopIfClaimLost(claim, 'slot-eligibility')) return;

    item.slotId = slot.slot;
    schedulePersist('mark-dispatching');
    console.log(`[dispatch-queue] auto-dispatching ${item.id.slice(0, 8)} → slot ${slot.slot}`);

    // Re-validate before entering createAndStartRun; that callback re-validates
    // again immediately before the durable createRun / evalTrialStart call.
    if (stopIfClaimLost(claim, 'pre-createAndStartRun')) return;

    try {
      await _createAndStartRun(item, claim);
      // Success: remove the row (claim no longer needed).
      const idx = queue.findIndex((q) => q.id === item.id);
      if (idx >= 0) {
        clearQueueProfileFitCache(queue[idx]);
        queue.splice(idx, 1);
      }
      schedulePersist('auto-dispatch-success');
      _broadcast('queue.updated', { items: listItems() });
    } catch (err) {
      if (err instanceof QueueClaimLostError) {
        console.log(`[dispatch-queue] ${err.message}`);
        return;
      }
      if (
        isStartRefPolicyError(err) ||
        (item.queueKind === 'eval-cell' && isNonRetryableEvalQueueError(err))
      ) {
        // Defense-in-depth: addItem validates startRef and eval queue shape before
        // persistence, but queued JSON can outlive code changes or manual edits.
        // Cancel non-retryable items loudly instead of head-of-line retry loops.
        if (isQueueClaimHeld(claim)) {
          item.status = 'cancelled';
          item.runId = undefined;
          clearClaimFields(item);
          clearQueueProfileFitCache(item);
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
      // Revert to queued on failure when we still own the claim.
      if (isQueueClaimHeld(claim)) {
        releaseQueueClaim(claim);
      }
      console.error(
        `[dispatch-queue] auto-dispatch failed for ${item.id.slice(0, 8)}: ${(err as Error).message}`,
      );
    }

    // Only dispatch one at a time per cycle
    return;
  }
}
