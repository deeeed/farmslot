import type { FamilyObservabilityRunSummary, SlotStatus } from '@farmslot/protocol';

import { canSlotAcceptRecipeRerun } from '../recipe/recipe-rerun-model.js';

export interface FamilyWarmSlotRerunCheck {
  ok: boolean;
  reason?: string;
  slotId?: string;
}

export function familySlotForRun(
  slots: readonly SlotStatus[],
  runId: string | undefined,
): SlotStatus | null {
  if (!runId) return null;
  return slots.find((slot) => slot.currentRunId === runId) ?? null;
}

export function familyWarmSlotRerunCheck(
  run: FamilyObservabilityRunSummary | null,
  slots: readonly SlotStatus[],
): FamilyWarmSlotRerunCheck {
  if (!run) return { ok: false, reason: 'no run selected' };
  const slot = familySlotForRun(slots, run.runId);
  if (!slot) return { ok: false, reason: 'slot not found (may have been released)' };
  if (!canSlotAcceptRecipeRerun(slot, { id: run.runId, slotId: run.slotId })) {
    return {
      ok: false,
      reason: `slot ${slot.slot} not in review-gate (${slot.lifecycle}${slot.phase ? ' / ' + slot.phase : ''})`,
    };
  }
  return { ok: true, slotId: slot.slot };
}
