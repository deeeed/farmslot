import { Events } from '@farmslot/protocol';

import { isSlotFreedByPark } from '../../run-engine/park-slot-binding.js';
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
    // A run whose park freed this slot is not the occupant this release is
    // tearing down — it gave the slot up so a successor could use it. Its
    // `slotId` is the park record's restore target and its preserved branch
    // key, so clearing it here would orphan the record every time the
    // successor releases.
    if (isSlotFreedByPark(run)) continue;
    const updated = updateRun(run.id, { slotId: null });
    detached.push(run.id);
    emit(Events.RUN_UPDATED, { run: updated });
  }
  return detached;
}
