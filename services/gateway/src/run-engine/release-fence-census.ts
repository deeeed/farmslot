import type { Run } from '@farmslot/protocol';

import { getRun } from '../runs/store.js';

/**
 * Read-only census of an interrupted release's checkout on `slotId`, for orphan recovery.
 * Refuses a run no longer bound to that slot. The census runs on a snapshot: the store
 * mutates the live record, and the census rereads slotId across its awaits, so every probe
 * stays on the slot whose fence the pass inspects.
 */
export async function releaseFenceCensus(run: Run, slotId: string): Promise<string | null> {
  const current = getRun(run.id);
  if (current?.slotId !== slotId)
    return `run ${run.id.slice(0, 8)} is no longer bound to ${slotId}`;
  const { slotTeardownBlocker } = await import('../run-lifecycle/slot-teardown.js');
  return slotTeardownBlocker({ ...current, slotId }, { inspectReleaseFence: true });
}
