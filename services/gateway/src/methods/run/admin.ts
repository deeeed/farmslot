import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  Events,
  type HumanGrade,
  isCompletionPrerequisiteFailure,
  isSettledBlockedRun,
  isTerminalRunStatus,
  normalizeRunLinkedTicketRefs,
  normalizeRunTags,
  type Run,
  type RunArchiveParams,
  type RunArchiveResult,
  type RunBulkDeleteParams,
  type RunBulkDeleteResult,
  type RunCleanupParams,
  type RunCleanupResult,
  type RunDeleteParams,
  type RunDeleteResult,
  type RunGetGradeParams,
  type RunGetGradeResult,
  type RunGradeParams,
  type RunGradeResult,
  type RunLinkedTicketsSetParams,
  type RunLinkedTicketsSetResult,
  type RunTagsListResult,
  type RunTagsSetParams,
  type RunTagsSetResult,
} from '@farmslot/protocol';

import { markBacklogRunReleased } from '../../backlog/store.js';
import {
  ownsRunSlotCleanup,
  readSlotField,
  readSlotRow,
  SLOT_PHASE_RELEASING,
} from '../../core/index.js';
import { cleanupReviewWorkspaceCaches } from '../../review-workspaces/cache-cleanup.js';
import { STALE_RELEASE_RECLAIM_MS } from '../../run-engine/recovery.js';
import { isTerminalTeardownInFlight } from '../../run-engine/terminal-teardown-registry.js';
import {
  assertRunNotArchiving,
  beginRunArchive,
  endRunArchive,
  isRunArchiving,
} from '../../run-lifecycle/archive-fence.js';
import { reuseSafeIdleSlot } from '../../run-lifecycle/safe-idle-slot.js';
import { slotOwnershipBlocker } from '../../run-lifecycle/slot-teardown.js';
import { withRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { nativeSessionManager } from '../../runners/native/manager.js';
import {
  archiveRun as storeArchiveRun,
  assertRunArchivable,
  blockedRunOwnsSlot,
  cleanupRuns as storeCleanup,
  deleteRun as storeDeleteRun,
  getAllRunsWithArchived,
  getRun,
  listRuns,
  listRunTags as storeListRunTags,
  persistRunNow,
  runsDirectory,
  updateRun,
} from '../../runs/store.js';
import { schedulerTick } from '../../work-graph/store.js';
import { slotRelease, slotReleasePreflight } from '../slot/release.js';

type Emit = (event: string, payload: unknown) => void;

export async function reconcileDeletedRun(
  runId: string,
  options: { keepNeedsAttention?: boolean } = {},
): Promise<void> {
  const graphIds = await markBacklogRunReleased(runId, options);
  for (const graphId of graphIds) await schedulerTick({ graphId });
}

export function runSetTags(params: RunTagsSetParams, emit: Emit): RunTagsSetResult {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);
  const tags = normalizeRunTags(params.tags);
  const run = updateRun(params.runId, { tags });
  emit(Events.RUN_UPDATED, { run });
  return { run };
}

export function runSetLinkedTickets(
  params: RunLinkedTicketsSetParams,
  emit: Emit,
): RunLinkedTicketsSetResult {
  if (!getRun(params.runId)) throw new Error(`Run not found: ${params.runId}`);
  const linkedTicketRefs = normalizeRunLinkedTicketRefs(params.linkedTicketRefs);
  const run = updateRun(params.runId, { linkedTicketRefs });
  emit(Events.RUN_UPDATED, { run });
  return { run };
}

export function runListTags(): RunTagsListResult {
  return { tags: storeListRunTags() };
}

export function runGrade(params: RunGradeParams, emit: Emit): RunGradeResult {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);

  if (!isTerminalRunStatus(existing.status)) {
    throw new Error(`Can only grade completed runs (status=${existing.status})`);
  }

  const run = updateRun(params.runId, { humanGrade: params.grade });

  // Also write grade.json for backward compat with FINE-TUNING.md scripts
  writeGradeArtifact(existing, params.grade);

  emit(Events.RUN_UPDATED, { run });
  return { run };
}

export function runGetGrade(params: RunGetGradeParams): RunGetGradeResult {
  const existing = getRun(params.runId);
  if (!existing) throw new Error(`Run not found: ${params.runId}`);
  return { grade: existing.humanGrade ?? null };
}

export async function runDelete(
  params: RunDeleteParams,
  emit: Emit,
  slot: ArchiveSlotRelease = ARCHIVE_SLOT_RELEASE,
): Promise<RunDeleteResult> {
  const ok = await withTerminalRunSlotReleased(getRun(params.runId), emit, slot, () =>
    storeDeleteRun(params.runId),
  );
  if (!ok) throw new Error(`Run not found: ${params.runId}`);
  await reconcileDeletedRun(params.runId);
  emit(Events.RUN_DELETED, { runId: params.runId });
  return { ok: true };
}

export interface ArchiveSlotRelease {
  preflight: typeof slotReleasePreflight;
  release: typeof slotRelease;
  returnToIdle: typeof reuseSafeIdleSlot;
}

const ARCHIVE_SLOT_RELEASE: ArchiveSlotRelease = {
  preflight: slotReleasePreflight,
  release: slotRelease,
  returnToIdle: reuseSafeIdleSlot,
};

export async function runArchive(
  params: RunArchiveParams,
  emit: Emit,
  slot: ArchiveSlotRelease = ARCHIVE_SLOT_RELEASE,
): Promise<RunArchiveResult> {
  const run = getRun(params.runId);
  const archivedAsBlocked = run?.status === 'blocked';
  let fenced = false;
  try {
    if (run && isSettledBlockedRun(run)) {
      await fenceBlockedRunArchive(run);
      fenced = true;
      await releaseBlockedRunSlot(run, emit, slot);
    }
    const archive = () => storeArchiveRun(params.runId);
    const ok = await (fenced
      ? archive()
      : withTerminalRunSlotReleased(run, emit, slot, archive, true));
    if (!ok) throw new Error(`Run not found: ${params.runId}`);
  } finally {
    if (fenced) endRunArchive(params.runId);
  }
  // Archiving a blocked run closes it; it must not requeue the backlog item.
  await reconcileDeletedRun(params.runId, { keepNeedsAttention: archivedAsBlocked });
  emit(Events.RUN_DELETED, { runId: params.runId });
  return { ok: true };
}

/**
 * Resume (operator or automatic) re-admits a blocked run under the run
 * transition, and the automatic one can re-bind a slot its block left free.
 * Re-check there and fence first, whether or not the slot still names the run:
 * replay and re-binding refuse a fenced run, and a replay in flight aborts at
 * its next ownership check. Archive refusals that need no slot I/O come first.
 */
async function fenceBlockedRunArchive(run: Run): Promise<void> {
  assertRunArchivable(run);
  await withRunTransition(run.id, async () => {
    const current = getRun(run.id);
    if (!current || !isSettledBlockedRun(current) || isRunArchiving(run.id)) {
      throw new Error(
        `Cannot archive run ${run.id}: it is no longer a settled blocked run (status=${current?.status ?? 'missing'}) or is already being archived`,
      );
    }
    beginRunArchive(run.id);
  });
}

/**
 * A fleet refresh re-holds a blocked run's slot. Archive frees it through the
 * ordinary slot release, whose guards decide, and checks them before anything
 * is torn down. The release runs outside the run transition because a native
 * handoff inside it takes run locks; the fence covers the run meanwhile.
 */
async function releaseBlockedRunSlot(
  run: Run,
  emit: Emit,
  slot: ArchiveSlotRelease,
): Promise<void> {
  if (!(await blockedRunOwnsSlot(run))) return;
  const slotId = run.slotId!;
  const preflight = await slot.preflight({ slotId, expectedRunId: run.id });
  if (!preflight) {
    // The slot is mid-release, or another run holds it now.
    if (await blockedRunOwnsSlot(run)) throw await slotStillHeldError(run.id, slotId);
    return;
  }
  if (preflight.unmergedWork) {
    const { branch, details } = preflight.unmergedWork;
    throw new Error(
      `Cannot archive blocked run ${run.id}: slot ${slotId} has work on '${branch}' (${details}) that releasing it would lose. Push or preserve it, then cancel the run with farmslot run cancel ${run.id} before releasing and archiving.`,
    );
  }
  const { released } = await slot.release({ slotId, expectedRunId: run.id }, emit);
  if (!released && (await readSlotField(slotId, 'current_run_id')) === run.id)
    throw await slotStillHeldError(run.id, slotId);
}

/**
 * Eviction stops a terminal run's owned worker before its ownership record leaves
 * the live store. Archive safely returns published work to idle; delete keeps
 * its existing checkout policy. The archive fence
 * prevents replay from reclaiming the slot during teardown.
 */
async function withTerminalRunSlotReleased(
  run: Run | undefined,
  emit: Emit,
  slot: ArchiveSlotRelease,
  evict: () => Promise<boolean>,
  archive = false,
): Promise<boolean> {
  if (!run || !isTerminalRunStatus(run.status)) return evict();
  // The store owns this recovery hold's eviction fence and requires explicit
  // workspace release before removal. Do not bypass it with ordinary cleanup.
  if (isCompletionPrerequisiteFailure(run)) return evict();
  assertRunArchivable(run);
  const expectedStatus = run.status;
  const fenced = await withRunTransition(run.id, async () => {
    const current = getRun(run.id);
    if (!current) return false;
    if (current.status !== expectedStatus) {
      if (isTerminalRunStatus(current.status))
        throw new Error(
          `Cannot evict run ${run.id}: status changed from ${expectedStatus} to ${current.status} while waiting for cleanup authority. Retry after that transition settles.`,
        );
      return false;
    }
    assertRunArchivable(current);
    assertRunNotArchiving(run.id);
    beginRunArchive(run.id);
    return true;
  });
  if (!fenced) return evict();
  try {
    await releaseKeptSlot(run, emit, slot, archive);
    return await evict();
  } finally {
    endRunArchive(run.id);
  }
}

/** Existing release guards protect foreign owners; keep finished workers' checkouts. */
async function releaseKeptSlot(
  run: Run,
  emit: Emit,
  slot: ArchiveSlotRelease,
  archive: boolean,
): Promise<void> {
  if (!run.slotId) return;
  const slotId = run.slotId;
  // Another active run owns the slot now; it keeps it.
  const before = await readSlotRow(slotId);
  if (!ownsRunSlotCleanup(before, run.id)) {
    // COMPLETE already released an artifact-only run's slot; archive still returns its checkout.
    if (archive) {
      const { returnReleasedCheckoutToIdle } =
        await import('../../run-lifecycle/safe-idle-slot.js');
      const result = await returnReleasedCheckoutToIdle(run, emit);
      if (result && result.kind !== 'ready') {
        const retained = updateRun(run.id, {
          slotTeardownSkipped: `Checkout retained: ${result.reason}`,
        });
        await persistRunNow(retained, 'released checkout retained');
        emit(Events.RUN_UPDATED, { run: retained });
      }
    }
    return;
  }
  const blocker = await slotOwnershipBlocker(run);
  if (blocker) throw new Error(`Cannot release slot ${slotId} of run ${run.id}: ${blocker}`);
  const { released } = await slot.release(
    {
      slotId,
      expectedRunId: run.id,
      ...(run.status === 'cancelled' && !archive ? { forceReset: true } : { keepWork: true }),
    },
    emit,
  );
  if (released && archive) {
    const result = await slot.returnToIdle(slotId, emit, {
      epoch: Number(before?.slot_epoch) || 0,
      runId: null,
      recordRunId: run.id,
    });
    if (result.kind !== 'ready') {
      const retained = updateRun(run.id, {
        slotTeardownSkipped: `Checkout retained: ${result.reason}`,
      });
      emit(Events.RUN_UPDATED, { run: retained });
    }
  }
  if (!released && ownsRunSlotCleanup(await readSlotRow(slotId), run.id))
    throw new Error(
      `Cannot release slot ${slotId} of ${run.status} run ${run.id}: it is still held`,
    );
}

async function slotStillHeldError(runId: string, slotId: string): Promise<Error> {
  const row = await readSlotRow(slotId);
  // A release that could not finish its teardown leaves the slot held and says why.
  if (row?.lifecycle === 'held' && typeof row.held_reason === 'string' && row.held_reason)
    return new Error(
      `Cannot archive blocked run ${runId}: slot ${slotId} was left held: ${row.held_reason}`,
    );
  // A fence no teardown in this process owns was left by a release a restart
  // cut short; retrying cannot clear it, only the orphan reconciler does.
  const interrupted = row?.phase === SLOT_PHASE_RELEASING && !isTerminalTeardownInFlight(slotId);
  return new Error(
    interrupted
      ? `Cannot archive blocked run ${runId}: slot ${slotId} is still fenced by a release that did not finish (a gateway restart interrupts one). Recovery reclaims it within ${STALE_RELEASE_RECLAIM_MS / 60_000} minutes of it being noticed, once its worker is stopped; archive again after that.`
      : `Cannot archive blocked run ${runId}: another release or a handoff is in progress on slot ${slotId}; retry`,
  );
}

export async function runBulkDelete(
  params: RunBulkDeleteParams,
  emit: Emit,
): Promise<RunBulkDeleteResult> {
  let deleted = 0;
  for (const id of params.runIds) {
    try {
      const ok = await withTerminalRunSlotReleased(getRun(id), emit, ARCHIVE_SLOT_RELEASE, () =>
        storeDeleteRun(id),
      );
      if (!ok) continue;
      await reconcileDeletedRun(id);
      deleted++;
    } catch (err) {
      // Bulk deletion is intentionally best-effort: one run may still be
      // reconciling its backlog link, while independent selected runs remain
      // safe to delete and must not be stranded behind it.
      console.warn(
        `[run] bulk delete skipped ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    emit(Events.RUN_DELETED, { runId: id });
  }
  return { deleted };
}

export async function runCleanup(
  params: RunCleanupParams,
  slot: ArchiveSlotRelease = ARCHIVE_SLOT_RELEASE,
): Promise<RunCleanupResult> {
  const dryRun = params.dryRun ?? true;
  // A week-old cancelled run is archived the way run.archive does it, releasing
  // the slot its cancel kept (ADR-054, 2026-10-19), so cleanup never orphans it.
  // Cleanup reports only its result, not release progress.
  const result = await storeCleanup(dryRun, (run) =>
    withTerminalRunSlotReleased(
      run,
      () => {},
      slot,
      () => storeArchiveRun(run.id),
      true,
    ),
  );
  const cacheDirsRemoved = await cleanupReviewWorkspaceCaches(dryRun, {
    runs: getAllRunsWithArchived,
    runsDir: runsDirectory(),
    nativeRoot: nativeSessionManager.root,
  });
  return { ...result, cacheDirsRemoved };
}

export interface RunBackfillSummariesParams {
  dryRun?: boolean;
}

export interface RunBackfillSummariesResult {
  processed: number;
  skipped: number;
  failed: number;
  details: Array<{ runId: string; ticketOrPr: string; summary: string; method: string }>;
}

export async function runBackfillSummaries(
  params: RunBackfillSummariesParams,
  emit: Emit,
): Promise<RunBackfillSummariesResult> {
  const { generateSummary } = await import('../../intelligence/engine.js');
  const { runs: allRuns } = listRuns({ limit: 500 });
  const needsSummary = allRuns.filter((r) => !r.summary);

  const result: RunBackfillSummariesResult = { processed: 0, skipped: 0, failed: 0, details: [] };

  for (const run of needsSummary) {
    try {
      let summary: string | undefined;
      let method = 'none';

      if (run.flowType === 'review-pr' || run.flowType === 'pr-complete') {
        // PR flows: use PR title from ticketData
        if (run.ticketData?.title) {
          summary = run.ticketData.title;
          method = 'pr-title';
        }
      } else if (run.ticketData) {
        // Bug/dev flows with ticket data: LLM summary
        if (params.dryRun) {
          summary = run.ticketData.title;
          method = 'dry-run-title';
        } else {
          const sr = await generateSummary(run.ticketData, run.flowType);
          summary = sr.summary;
          method = 'llm';
        }
      } else {
        // No ticket data — skip, nothing useful to show
        result.skipped++;
        continue;
      }

      if (!summary) {
        result.skipped++;
        continue;
      }

      if (!params.dryRun) {
        updateRun(run.id, { summary });
        emit(Events.RUN_UPDATED, { run: getRun(run.id) });
      }
      result.processed++;
      result.details.push({
        runId: run.id.slice(0, 8),
        ticketOrPr: run.ticketOrPr,
        summary,
        method,
      });
    } catch (err) {
      console.warn(
        `[run] backfill summary failed for ${run.id.slice(0, 8)}: ${(err as Error).message}`,
      );
      result.failed++;
    }
  }

  console.log(
    `[run] backfill summaries: ${result.processed} processed, ${result.skipped} skipped, ${result.failed} failed (dryRun=${params.dryRun ?? true})`,
  );
  return result;
}

async function writeGradeArtifact(run: Run, grade: HumanGrade): Promise<void> {
  if (!run.taskFile) return;
  try {
    const taskDir = path.dirname(run.taskFile);
    const artifactsDir = path.join(taskDir, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(artifactsDir, 'grade.json'), JSON.stringify(grade, null, 2), 'utf-8');
  } catch (err) {
    console.warn(`[run] grade artifact write failed: ${(err as Error).message}`);
  }
}
