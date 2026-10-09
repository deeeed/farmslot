import { Events, isSlotFreedByPark } from '@farmslot/protocol';

import { listRuns, updateRun } from '../../runs/store.js';

type Emit = (event: string, payload: unknown) => void;

/**
 * Explicit slot release means the run keeps its ledger/gate state but no
 * longer owns the physical slot. Without this detach, fleet.refresh rehydrates
 * current_run_id from active blocked/human-gate runs and immediately re-holds
 * the slot that was just released.
 *
 * Only runs that held the slot lose it: the released owner, and runs past
 * find-slot. A run still in find-slot names the slot only as its explicit pick,
 * waiting for this very release; clearing that pin made it take another slot.
 */
export function detachRunsForReleasedSlot(
  slotId: string,
  emit: Emit,
  ownerRunId?: string | null,
): string[] {
  const detached: string[] = [];
  for (const run of listRuns({ active: true }).runs) {
    if (run.slotId !== slotId) continue;
    const waitingForSlot = run.steps.some(
      (step) =>
        step.name === 'find-slot' && (step.status === 'pending' || step.status === 'running'),
    );
    if (waitingForSlot && run.id !== ownerRunId) continue;
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
