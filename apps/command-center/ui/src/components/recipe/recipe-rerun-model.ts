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
    // A slot bound to this run accepts a recipe rerun when it is parked at the
    // review gate, held, or freshly prepared/idle (`ready`) — the last is the
    // state after an operator warm branch switch. A mid-worker (busy) slot is
    // still rejected so a replay never collides with a live worker.
    return slot.phase === 'review-gate' || slot.lifecycle === 'held' || slot.lifecycle === 'ready';
  }
  return Boolean(slot.phase === 'review-gate' && run.slotId && slot.slot === run.slotId);
}
