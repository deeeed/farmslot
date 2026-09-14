/** Synchronous admission prevents preparation and recovery from crossing awaits. */
export const activePrepareSlots = new Set<string>();
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
