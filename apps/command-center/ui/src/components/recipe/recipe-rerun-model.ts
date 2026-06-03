export interface RecipeRerunSlot {
  slot?: string | null;
  currentRunId?: string | null;
  phase?: string | null;
  lifecycle?: string | null;
}

export interface RecipeRerunRun {
  id: string;
  slotId?: string | null;
}

export function canSlotAcceptRecipeRerun(
  slot: RecipeRerunSlot | null | undefined,
  run: RecipeRerunRun | null | undefined,
): boolean {
  if (!slot || !run) return false;
  if (slot.currentRunId && slot.currentRunId !== run.id) return false;
  if (slot.currentRunId === run.id) {
    return slot.phase === 'review-gate' || slot.lifecycle === 'held';
  }
  return Boolean(slot.phase === 'review-gate' && run.slotId && slot.slot === run.slotId);
}
