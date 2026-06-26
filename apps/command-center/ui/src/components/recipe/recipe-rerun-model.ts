export interface RecipeRerunSlot {
  slot?: string | null;
  currentRunId?: string | null;
  phase?: string | null;
  lifecycle?: string | null;
  agent?: string | null;
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
    // Operator load-run / warm switch binds currentRunId without always resetting
    // lifecycle to `ready`. Reject only when a live worker still owns the slot.
    if (slot.agent === 'working') return false;
    return true;
  }
  return Boolean(slot.phase === 'review-gate' && run.slotId && slot.slot === run.slotId);
}

export function slotRecipeReplayBlockReason(input: {
  slot: RecipeRerunSlot | null | undefined;
  run: RecipeRerunRun | null | undefined;
  slotId: string;
  effectiveRecipeJson: string | null;
  canRerun: boolean;
  selectedRecipeRunId: string;
}): string | null {
  if (!input.run) return null;
  if (!input.effectiveRecipeJson) return 'Recipe JSON is not loaded yet.';
  if (!input.slotId) return 'Open a live slot to replay on.';
  if (!canSlotAcceptRecipeRerun(input.slot, input.run)) {
    if (input.slot?.currentRunId && input.slot.currentRunId !== input.run.id) {
      return `Slot is bound to run ${input.slot.currentRunId.slice(0, 8)}, not this run. Use Load run again to rebind.`;
    }
    if (input.slot?.agent === 'working') {
      return 'Slot has a live worker — wait until it finishes before replaying the recipe.';
    }
    if (!input.slot?.currentRunId) {
      return 'Slot is not bound to this run yet. Finish load-run prepare or use Prepare to bind it.';
    }
    return 'Slot is not ready for recipe replay on this run.';
  }
  if (!input.canRerun && !input.selectedRecipeRunId) {
    return 'Select the recipe package (Bundle) to replay the root recipe definition.';
  }
  return null;
}
