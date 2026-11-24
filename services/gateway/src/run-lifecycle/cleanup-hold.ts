import { isCompletionPrerequisiteFailure, isTerminalRunStatus, type Run } from '@farmslot/protocol';

import { SLOT_CLEANUP_STOP_UNCONFIRMED } from '../core/index.js';
import { isActiveSlotHolder } from '../methods/dispatch/slot-scoring.js';

/** The census blocker for a process still running in the slot repository. */
export function processInSlotRepoReason(pid: string): string {
  return `Process ${pid} still uses the slot repository; slot teardown was skipped`;
}

export const UNREADABLE_CENSUS_REASON =
  'Workspace process identity census is unreadable; slot teardown was skipped';

const [processReasonHead, processReasonTail] = processInSlotRepoReason('\0').split('\0');

/** A hold the workspace census wrote: its process exits by itself, so the hold clears. */
export function isWorkspaceCensusReason(reason: unknown): boolean {
  if (typeof reason !== 'string') return false;
  if (reason === UNREADABLE_CENSUS_REASON) return true;
  if (!reason.startsWith(processReasonHead) || !reason.endsWith(processReasonTail)) return false;
  return /^\d+$/.test(reason.slice(processReasonHead.length, -processReasonTail.length));
}

export type CleanupHoldRun = Pick<Run, 'id' | 'slotId' | 'status' | 'park'> &
  Partial<Pick<Run, 'steps'>>;

/** The run whose cleanup a held slot retries, or undefined when the hold grants no authority. */
export function cleanupHoldRunId(row: Readonly<Record<string, unknown>>): string | undefined {
  const runId = row.current_run_id || row.cleanup_run_id;
  return typeof runId === 'string' ? runId : undefined;
}

/** Whether the held-slot pass may retry `run`'s cleanup of this occupied slot. */
export function occupiedHoldRetryable<T extends CleanupHoldRun>(
  slotId: string,
  row: Readonly<Record<string, unknown>>,
  run: T | undefined,
): run is T {
  return Boolean(
    row.lifecycle === 'held' &&
    row.phase === 'occupied' &&
    row[SLOT_CLEANUP_STOP_UNCONFIRMED] !== true &&
    run &&
    run.id === cleanupHoldRunId(row) &&
    run.slotId === slotId &&
    isTerminalRunStatus(run.status) &&
    // A cancelled run keeps the slot it still owns for replay until release,
    // delete or archive (ADR-054); its cleanup hold is retried as before.
    !(run.status === 'cancelled' && row.current_run_id === run.id) &&
    !isCompletionPrerequisiteFailure(run) &&
    !isActiveSlotHolder(run),
  );
}

/**
 * A finished run's cleanup found a process still exiting in the slot repository. The held-slot
 * pass retries that cleanup every minute and releases the slot once the process is gone, so a
 * claim can wait for it instead of failing.
 */
export function cleanupHoldClearsSoon(
  slotId: string,
  row: Readonly<Record<string, unknown>> | null,
  lookup: (id: string) => CleanupHoldRun | undefined,
): boolean {
  if (!row || row.current_run_id || row.handoff_run_id) return false;
  if (!isWorkspaceCensusReason(row.held_reason)) return false;
  const runId = cleanupHoldRunId(row);
  return runId !== undefined && occupiedHoldRetryable(slotId, row, lookup(runId));
}
