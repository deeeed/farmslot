import type { Run } from '../contracts/runs.js';
import type { SlotStatus } from '../contracts/slots.js';
import { Methods } from '../rpc/registry.js';
import type { SlotReleaseParams, SlotReleaseResult } from '../rpc/slot.js';

/**
 * The held reason of a slot a cancelled run keeps for replay (ADR-054
 * amendment, 2026-10-19). The gateway writes it; clients match it exactly.
 */
export function cancelledRunHoldReason(runId: string): string {
  return `Held by cancelled run ${runId}: replay it or release the slot`;
}

/** A slot a cancelled run still holds, and the release every client offers for it. */
export interface CancelledRunSlotHold {
  slotId: string;
  runId: string;
  label: string;
  releaseLabel: string;
  releaseConfirm: string;
  /** The release `run.delete` does: the run as the expected owner, with reset. */
  releaseParams: SlotReleaseParams;
}

type HoldSlot = Pick<SlotStatus, 'slot' | 'lifecycle' | 'phase' | 'currentRunId' | 'heldReason'>;

export function cancelledRunSlotHold(slot: HoldSlot): CancelledRunSlotHold | null {
  const runId = slot.currentRunId;
  if (!runId || slot.lifecycle !== 'held' || slot.phase !== 'occupied') return null;
  if (slot.heldReason !== cancelledRunHoldReason(runId)) return null;
  return {
    slotId: slot.slot,
    runId,
    label: `held by cancelled run ${runId.slice(0, 8)}`,
    releaseLabel: 'Release slot',
    releaseConfirm: `Release ${slot.slot}? This resets its checkout and discards the cancelled run's local work.`,
    releaseParams: { slotId: slot.slot, expectedRunId: runId, forceReset: true },
  };
}

/** A cancelled run's two choices while it still holds its slot. */
export interface CancelledRunSlotChoices {
  hold: CancelledRunSlotHold;
  /** The step the cancel stopped: the last one that started. */
  replayStepName: string;
  replayLabel: string;
}

export function cancelledRunSlotChoices(
  run: Pick<Run, 'id' | 'status' | 'steps'>,
  slots: readonly HoldSlot[],
): CancelledRunSlotChoices | null {
  if (run.status !== 'cancelled') return null;
  const hold = slots.map(cancelledRunSlotHold).find((found) => found?.runId === run.id);
  const replayStepName =
    run.steps
      .slice()
      .reverse()
      .find((step) => step.startedAt)?.name ?? run.steps[0]?.name;
  if (!hold || !replayStepName) return null;
  return { hold, replayStepName, replayLabel: `Replay from ${replayStepName}` };
}

/** Releases the slot; returns why it was not released, or null once it was. */
export async function releaseCancelledRunSlot(
  request: (method: string, params: SlotReleaseParams) => Promise<SlotReleaseResult>,
  hold: CancelledRunSlotHold,
): Promise<string | null> {
  const result = await request(Methods.SLOT_RELEASE, hold.releaseParams);
  return result.released ? null : (result.reason ?? `Slot ${hold.slotId} was not released`);
}
