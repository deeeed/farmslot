// dispatch-queue.ts — In-memory queue + JSON file persistence
// Items persist across gateway restarts. Auto-dispatches when slots free up.

import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DispatchQueueUpdateParams, QueueItem, SlotStatus } from '@farmslot/protocol';

import type { InternalDispatchQueueAddParams } from '../core/queue-types.js';
import { evalSuiteCapUsage } from '../evals/suite-cap-store.js';
import { farmslotRoot, loadFleetStatus } from '../fleet/state.js';
import { resolveDispatchPreviewFromFleet } from '../methods/dispatch.js';
import { isStartRefPolicyError, normalizeStartRefRequest } from '../projects/start-ref-policy.js';
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

type BroadcastFn = (event: string, payload: unknown) => void;
let _broadcast: BroadcastFn | null = null;
let _createAndStartRun: ((item: QueueItem) => Promise<void>) | null = null;
let dispatchInFlight: Promise<void> | null = null;

export function initDispatchQueue(
  broadcast: BroadcastFn,
  createAndStartRun: (item: QueueItem) => Promise<void>,
): void {
  _broadcast = broadcast;
  _createAndStartRun = createAndStartRun;
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
  await writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
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
        // Gateway shutdown between dequeue and run creation leaves no durable
        // run to reconcile, so reset the item and let normal queue dispatch try
        // again instead of dropping it on restart.
        normalized.status = 'queued';
        normalized.runId = undefined;
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
  const startRef = normalizeStartRefRequest(params);
  const item: QueueItem = {
    id: randomUUID(),
    queueKind: params.queueKind ?? 'dispatch',
    backlogItemId: params.backlogItemId,
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
    app: params.app,
    model: params.model,
    runner: params.runner,
    effort: params.effort,
    mode: params.mode,
    devInteractiveProfile: params.devInteractiveProfile,
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

export function removeItem(itemId: string): void {
  const idx = queue.findIndex((q) => q.id === itemId);
  if (idx < 0) throw new Error(`Queue item not found: ${itemId}`);
  if (queue[idx]?.backlogItemId) {
    throw new Error('Cannot remove backlog-linked queue item directly; use backlog controls');
  }
  queue.splice(idx, 1);
  schedulePersist('remove');
  console.log(`[dispatch-queue] removed item ${itemId.slice(0, 8)}`);
  broadcastQueue();
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
    // Forward the UI-resolved allow list so the dispatcher refuses to land the
    // queued run on a machine the operator explicitly filtered out.
    allowedSlots: item.allowedSlots ?? undefined,
    targetBranch,
  };
}

export function selectQueueDispatchSlot(slots: SlotStatus[], item: QueueItem): string | null {
  const preview = resolveDispatchPreviewFromFleet(buildQueuePreviewParams(item), slots);
  return preview.preview.slotId;
}

// ─── Auto-dispatch ───

export function canDispatchQueuedItemToSlot(slot: SlotStatus): boolean {
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

async function tryDispatchNextOnce(): Promise<void> {
  if (!_broadcast || !_createAndStartRun) return;

  const pending = listItems();
  if (pending.length === 0) return;

  const fleet = await loadFleetStatus();

  for (const item of pending) {
    if (item.queueKind === 'eval-cell' && item.evalCell) {
      const usage = evalSuiteCapUsage(item.evalCell.capGroupId, queue);
      if (usage.active + usage.dispatching >= usage.cap) {
        continue;
      }
    }

    let slot: SlotStatus | undefined;
    try {
      const slotId = selectQueueDispatchSlot(fleet.slots, item);
      slot = fleet.slots.find((s) => s.slot === slotId);
    } catch (error) {
      console.debug(
        `[dispatch-queue] skipping queued item ${item.id.slice(0, 8)}: ${(error as Error).message}`,
      );
      continue;
    }

    if (!slot || !canDispatchQueuedItemToSlot(slot)) continue;
    item.slotId = slot.slot;

    // Mark as dispatching and create a run
    item.status = 'dispatching';
    schedulePersist('mark-dispatching');
    console.log(`[dispatch-queue] auto-dispatching ${item.id.slice(0, 8)} → slot ${slot.slot}`);

    try {
      await _createAndStartRun(item);
      // Remove from queue on success
      const idx = queue.findIndex((q) => q.id === item.id);
      if (idx >= 0) queue.splice(idx, 1);
      schedulePersist('auto-dispatch-success');
      _broadcast('queue.updated', { items: listItems() });
    } catch (err) {
      if (
        isStartRefPolicyError(err) ||
        (item.queueKind === 'eval-cell' && isNonRetryableEvalQueueError(err))
      ) {
        // Defense-in-depth: addItem validates startRef and eval queue shape before
        // persistence, but queued JSON can outlive code changes or manual edits.
        // Cancel non-retryable items loudly instead of head-of-line retry loops.
        item.status = 'cancelled';
        item.runId = undefined;
        schedulePersist(
          isStartRefPolicyError(err)
            ? 'auto-dispatch-start-ref-policy-failure'
            : 'auto-dispatch-eval-policy-failure',
        );
        console.error(
          `[dispatch-queue] cancelling invalid queued item ${item.id.slice(0, 8)}: ${(err as Error).message}`,
        );
        _broadcast('queue.updated', { items: listItems() });
        return;
      }
      // Revert to queued on failure
      item.status = 'queued';
      item.runId = undefined;
      schedulePersist('auto-dispatch-failure');
      console.error(
        `[dispatch-queue] auto-dispatch failed for ${item.id.slice(0, 8)}: ${(err as Error).message}`,
      );
    }

    // Only dispatch one at a time per cycle
    return;
  }
}
