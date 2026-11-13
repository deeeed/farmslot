import { isTerminalRunStatus } from '@farmslot/protocol';

import {
  execOnSlot,
  loadSlotVars,
  markSlotStatusIf,
  readSlotRow,
  slotReleasingFenceFields,
  updateSlotStatusIf,
} from '../core/index.js';
import { loadPoolConfigs } from '../fleet/state.js';
import { activePrepareSlots } from '../methods/slot/shared.js';
import { workspaceProtectedReason } from '../methods/slot/workspace.js';
import { runNeedsExecutionStorage } from '../review-workspaces/storage-use.js';
import { getAllRuns } from '../runs/store.js';

import { retainSlotParkedWork } from './validation-run-commits.js';

/** Existing hourly retention owns this pass. Slot fences keep it out of live work. */
export async function parkedWorkRetentionPass(now = new Date()): Promise<void> {
  const rawDays = process.env.FARMSLOT_PARKED_WORK_RETENTION_DAYS;
  const days = rawDays === undefined ? 14 : Number(rawDays);
  if (!Number.isFinite(days) || days <= 0) throw new Error('Invalid parked-work retention days');
  const protectedBySlot = new Map<string, string[]>();
  for (const run of getAllRuns()) {
    if (isTerminalRunStatus(run.status) && !runNeedsExecutionStorage(run)) continue;
    for (const receipt of run.parkedCommits ?? []) {
      const refs = protectedBySlot.get(receipt.slotId) ?? [];
      refs.push(receipt.ref);
      protectedBySlot.set(receipt.slotId, refs);
    }
  }
  for (const pool of await loadPoolConfigs())
    for (const slot of pool.slots) {
      const slotId = slot.id;
      if (activePrepareSlots.has(slotId)) continue;
      const row = await readSlotRow(slotId);
      if (
        !row ||
        row.lifecycle !== 'ready' ||
        row.phase === 'releasing' ||
        row.current_run_id ||
        row.cleanup_run_id ||
        row.handoff_run_id ||
        row.workspace_recovery ||
        (await workspaceProtectedReason(slotId, row))
      )
        continue;
      activePrepareSlots.add(slotId);
      let claimed = false;
      const owns = (current: Readonly<Record<string, unknown>>) =>
        current.slot_epoch === row.slot_epoch &&
        !current.current_run_id &&
        !current.cleanup_run_id &&
        !current.handoff_run_id &&
        !current.workspace_recovery &&
        current.phase === 'releasing';
      try {
        const mark = await markSlotStatusIf(
          slotId,
          (current) =>
            current.slot_epoch === row.slot_epoch &&
            current.lifecycle === 'ready' &&
            current.phase !== 'releasing' &&
            !current.current_run_id &&
            !current.cleanup_run_id &&
            !current.handoff_run_id &&
            !current.workspace_recovery,
          slotReleasingFenceFields(),
        );
        if (!mark.applied) continue;
        claimed = true;
        await retainSlotParkedWork(
          await loadSlotVars(slotId),
          protectedBySlot.get(slotId) ?? [],
          now,
          days,
          execOnSlot,
        );
      } catch (error) {
        // Per-slot retention failure retains all remaining refs and does not skip other slots.
        console.error(
          `[parked-work retention] ${slotId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (claimed)
          await updateSlotStatusIf(slotId, owns, {
            lifecycle: row.lifecycle,
            phase: row.phase,
            releasing_since: null,
          });
        activePrepareSlots.delete(slotId);
      }
    }
}
