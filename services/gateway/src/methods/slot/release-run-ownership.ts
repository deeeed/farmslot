import { Events } from '@farmslot/protocol';

import { listRuns, updateRun } from '../../runs/store.js';

type Emit = (event: string, payload: unknown) => void;

/**
 * Explicit slot release means the run keeps its ledger/gate state but no
 * longer owns the physical slot. Without this detach, fleet.refresh rehydrates
 * current_run_id from active blocked/human-gate runs and immediately re-holds
 * the slot that was just released.
 */
export function detachRunsForReleasedSlot(slotId: string, emit: Emit): string[] {
  const detached: string[] = [];
  for (const run of listRuns({ active: true }).runs) {
    if (run.slotId !== slotId) continue;
    const updated = updateRun(run.id, { slotId: null });
    detached.push(run.id);
    emit(Events.RUN_UPDATED, { run: updated });
  }
  return detached;
}
