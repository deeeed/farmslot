import {
  type CleanupCommands,
  cleanupSignal,
  drainCleanupCommands,
  withCleanupSignal,
} from '../core/cleanup-scope.js';

/**
 * Slots whose terminal teardown is in flight in THIS process (ADR-053).
 *
 * A terminal run publishes its status before its slot teardown starts, which is
 * the whole point of the transition router. That leaves a window where the run
 * is terminal and its slot is still occupied — and `activeRunSlotIds` counts
 * only non-terminal runs, so for the length of that window the slot looks
 * orphaned to `reconcileOrphanedSlots`. The reconciler would reset it to ready
 * mid-teardown, dispatch could hand it to a new run, and the dying release
 * would then kill windows and reset the worktree under its new occupant.
 *
 * Deliberately in memory rather than on the run record. The claim is "a
 * teardown is running right now", which a restart ends: a durable marker would
 * survive the crash that ended the teardown and fence the slot from
 * reclamation forever, turning a transient race into a permanently stranded
 * slot. After a restart the reconciler SHOULD reclaim these slots, and with an
 * empty registry it does.
 *
 * Counted rather than a plain set so two overlapping teardowns on one slot
 * cannot have the first to finish clear the second's protection.
 *
 * `slotRelease` registers here too: an operator release is no terminal run,
 * but it is a teardown the reconciler must not reclaim from under itself.
 */
const teardownsBySlot = new Map<string, number>();

export function beginTerminalTeardown(slotId: string): void {
  teardownsBySlot.set(slotId, (teardownsBySlot.get(slotId) ?? 0) + 1);
}

export function endTerminalTeardown(slotId: string): void {
  const remaining = (teardownsBySlot.get(slotId) ?? 0) - 1;
  if (remaining > 0) teardownsBySlot.set(slotId, remaining);
  else teardownsBySlot.delete(slotId);
}

/** Whether a terminal teardown currently owns this slot's lifecycle. */
export function isTerminalTeardownInFlight(slotId: string): boolean {
  return (teardownsBySlot.get(slotId) ?? 0) > 0;
}

/** Slots currently protected, for diagnostics and tests. */
export function terminalTeardownSlots(): string[] {
  return [...teardownsBySlot.keys()];
}

/** Includes the existing three-minute wait for an aborted prepare to settle. */
export const TERMINAL_TEARDOWN_TIMEOUT_MS = 5 * 60_000;

export class TerminalTeardownTimeoutError extends Error {
  closeoutConfirmed = true;
  constructor(slotId: string, timeoutMs: number) {
    super(`Terminal teardown for ${slotId} timed out after ${timeoutMs}ms`);
    this.name = 'TerminalTeardownTimeoutError';
  }
}

/** Bound the awaited teardown, not just its marker. A late result owns no new work. */
export async function withTerminalTeardown<T>(
  slotId: string,
  operation: () => Promise<T>,
  timeoutMs: number | null = TERMINAL_TEARDOWN_TIMEOUT_MS,
): Promise<T> {
  // A warm recycle re-prepares under its existing phase budgets.
  if (timeoutMs === null && !cleanupSignal()) {
    beginTerminalTeardown(slotId);
    try {
      return await operation();
    } finally {
      endTerminalTeardown(slotId);
    }
  }
  const commands: CleanupCommands = { pending: new Set(), unconfirmed: false };
  const controller = new AbortController();
  const signal = cleanupSignal(controller.signal)!;
  let rejectAborted: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = () => reject(signal.reason);
  });
  signal.addEventListener('abort', rejectAborted, { once: true });
  const timer =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          const error = new TerminalTeardownTimeoutError(slotId, timeoutMs);
          console.warn(`[teardown] ${error.message}`);
          controller.abort(error);
        }, timeoutMs);
  beginTerminalTeardown(slotId);
  try {
    signal.throwIfAborted();
    return await Promise.race([withCleanupSignal(signal, operation, commands), aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', rejectAborted);
    if (
      signal.aborted &&
      !(await drainCleanupCommands(commands)) &&
      signal.reason instanceof TerminalTeardownTimeoutError
    )
      signal.reason.closeoutConfirmed = false;
    endTerminalTeardown(slotId);
  }
}
