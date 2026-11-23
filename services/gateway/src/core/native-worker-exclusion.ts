/**
 * Slots an in-process prepare, recovery or upkeep holds. A cleared guard is announced, so a
 * run waiting for a slot that read ready under the guard re-checks without a fleet change.
 */
class PrepareGuards extends Set<string> {
  private readonly listeners = new Set<(slotId: string) => void>();

  /** Calls `listener` for each cleared guard; returns its unsubscribe. */
  onCleared(listener: (slotId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  override delete(slotId: string): boolean {
    const removed = super.delete(slotId);
    // Deletes run in finally blocks: a failing listener must not mask their error or cleanup.
    if (removed)
      for (const listener of this.listeners) {
        try {
          listener(slotId);
        } catch (error) {
          console.error(
            `[prepare-guard] clear listener failed for ${slotId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
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
