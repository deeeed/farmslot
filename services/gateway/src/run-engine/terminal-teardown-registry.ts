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
