/**
 * Slots an in-process prepare, recovery or upkeep holds. A cleared guard is announced, so a
 * run waiting for a slot that read ready under the guard re-checks without a fleet change.
 */
class PrepareGuards extends Set<string> {
  private cleared?: (slotId: string) => void;

  onCleared(listener: (slotId: string) => void): void {
    this.cleared = listener;
  }

  override delete(slotId: string): boolean {
    const removed = super.delete(slotId);
    if (removed) this.cleared?.(slotId);
    return removed;
  }
}

/** Synchronous admission prevents preparation and recovery from crossing awaits. */
export const activePrepareSlots = new PrepareGuards();
const recoveringSlots = new Set<string>();

export function assertNoNativeWorkerRecovery(slotId: string): void {
  if (recoveringSlots.has(slotId))
    throw new Error(`Slot ${slotId} has an active native worker recovery`);
}

export function acquireNativeWorkerRecovery(slotId: string): () => void {
  if (activePrepareSlots.has(slotId))
    throw new Error(`Slot ${slotId} is preparing; native worker recovery is unavailable`);
  assertNoNativeWorkerRecovery(slotId);
  recoveringSlots.add(slotId);
  return () => recoveringSlots.delete(slotId);
}
