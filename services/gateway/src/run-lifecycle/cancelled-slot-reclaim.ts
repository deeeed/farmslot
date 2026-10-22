import type { Run } from '@farmslot/protocol';

import { readSlotRow, SLOT_PHASE_RELEASING } from '../core/index.js';
import { getRun, persistRunNow, updateRun } from '../runs/store.js';

import { defaultCancelCollaborators } from './cancel-transition.js';
import { withRunTransition } from './transition-coordinator.js';

/** Cancel preserves replay until a new selection explicitly needs its slot. */
export async function reclaimCancelledSlot(
  slotId: string,
  requestingRunId: string,
): Promise<boolean> {
  const row = await readSlotRow(slotId);
  const holderId = row?.current_run_id;
  if (typeof holderId !== 'string' || holderId === requestingRunId) return false;
  return withRunTransition(holderId, async () => {
    const holder = getRun(holderId);
    const current = await readSlotRow(slotId);
    if (
      !holder ||
      holder.status !== 'cancelled' ||
      holder.slotId !== slotId ||
      current?.current_run_id !== holderId ||
      current.phase === SLOT_PHASE_RELEASING ||
      current.handoff_run_id ||
      getRun(requestingRunId)?.status === 'cancelled'
    )
      return false;
    const cleanup = defaultCancelCollaborators({ keepForReplay: false });
    await cleanup.releaseCapabilities(holder);
    // Persist refusal before making the slot available, so a crash cannot let an
    // old replay adopt a checkout that a successor has already prepared.
    const preserved = updateRun(holderId, {
      slotReclaimed: { slotId, byRunId: requestingRunId, at: new Date().toISOString() },
    });
    await persistRunNow(preserved, 'cancelled slot reclaimed');
    try {
      const result = await cleanup.releaseSlot(holder);
      if (result?.skipped)
        throw new Error(`Cancelled slot ${slotId} cleanup refused: ${result.skipped}`);
    } catch (error) {
      const retained = await readSlotRow(slotId);
      if (retained?.current_run_id === holderId || retained?.cleanup_run_id === holderId) {
        await persistRunNow(
          updateRun(holderId, { slotReclaimed: undefined }),
          'cancelled reclaim refused',
        );
      }
      throw error;
    }
    const released = await readSlotRow(slotId);
    if (released?.current_run_id === holderId || released?.cleanup_run_id === holderId)
      return false;
    return true;
  });
}

export function cancelledSlotReplayRefusal(
  run: Pick<Run, 'id' | 'status' | 'slotReclaimed'>,
): string | null {
  const reclaimed = run.slotReclaimed;
  return run.status === 'cancelled' && reclaimed
    ? `Cancelled run ${run.id} cannot replay: slot ${reclaimed.slotId} was reclaimed by run ${reclaimed.byRunId} at ${reclaimed.at}. The run record and evidence are preserved.`
    : null;
}
