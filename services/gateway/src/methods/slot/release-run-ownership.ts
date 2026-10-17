import { Events, isSlotFreedByPark, refusedCompletionStep } from '@farmslot/protocol';

import { markBacklogRunObserved } from '../../backlog/store.js';
import { scheduledGraphOf } from '../../run-engine/stack-base.js';
import { getRun, listRuns, updateRun, updateRunStep } from '../../runs/store.js';
import { schedulerTick } from '../../work-graph/store.js';
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
 *
 * The request emit reaches only the caller, so publish to every client and
 * settle the backlog and the family edge here, as the observed lane would.
 */
export async function markCompletionFailureDiscarded(
  runId: string,
  broadcast?: Emit,
): Promise<void> {
  const run = getRun(runId);
  const refused = run ? refusedCompletionStep(run) : undefined;
  if (!refused || refused.outputs?.gatePrerequisiteDiscardedAt !== undefined) return;
  const updated = updateRunStep(runId, refused.name, {
    outputs: { ...refused.outputs, gatePrerequisiteDiscardedAt: new Date().toISOString() },
  });
  const publish = broadcast ?? (await import('../../server.js')).broadcastEvent;
  publish(Events.RUN_UPDATED, { run: updated });
  // The slot is already released and the stamp is durable; a failed settle is
  // logged like the observed lane's, not reported as a failed release.
  try {
    await markBacklogRunObserved(updated);
    const graphId = scheduledGraphOf(updated);
    if (graphId) await schedulerTick({ graphId });
  } catch (err) {
    console.error(`[slot.release] discarded run ${runId} settle failed: ${(err as Error).message}`);
  }
}
