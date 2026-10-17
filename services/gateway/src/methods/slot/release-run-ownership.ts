import {
  Events,
  isCompletionPrerequisiteFailure,
  isSlotFreedByPark,
  PipelineSteps,
} from '@farmslot/protocol';

import { getRun, listRuns, updateRun, updateRunStep } from '../../runs/store.js';
import { slotPinIsRequestOnly } from '../dispatch/slot-scoring.js';

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
    if (run.id !== ownerRunId && slotPinIsRequestOnly(run)) continue;
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

/**
 * The named forced release of a run whose completion prerequisite was refused
 * discards its retained workspace. Stamp the refused step so every active run
 * list treats the run as settled; the refusal stays as history.
 */
export function markCompletionFailureDiscarded(runId: string, emit: Emit): void {
  const run = getRun(runId);
  if (!run || !isCompletionPrerequisiteFailure(run)) return;
  const refused = run.steps.find(
    (step) =>
      (step.name === PipelineSteps.COMPLETE || step.name === PipelineSteps.FINALIZE) &&
      step.status === 'failed' &&
      step.outputs?.gatePrerequisiteRefusal !== undefined,
  );
  if (!refused || refused.outputs?.gatePrerequisiteDiscardedAt !== undefined) return;
  const updated = updateRunStep(runId, refused.name, {
    outputs: { ...refused.outputs, gatePrerequisiteDiscardedAt: new Date().toISOString() },
  });
  emit(Events.RUN_UPDATED, { run: updated });
}
