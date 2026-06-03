import type { RecipeRunArtifactGroup } from '@farmslot/protocol';

export type RecipeRunIdLike = Pick<RecipeRunArtifactGroup, 'id'>;

export function recipeRunIdExists(
  recipeRuns: readonly RecipeRunIdLike[],
  recipeRunId: string | null | undefined,
): recipeRunId is string {
  return Boolean(recipeRunId && recipeRuns.some((group) => group.id === recipeRunId));
}

export function firstAvailableRecipeRunId(recipeRuns: readonly RecipeRunIdLike[]): string {
  return recipeRuns[0]?.id ?? '';
}

export function desiredRecipeRunId(
  recipeRuns: readonly RecipeRunIdLike[],
  candidateIds: readonly (string | null | undefined)[],
): string {
  return (
    candidateIds.find((recipeRunId) => recipeRunIdExists(recipeRuns, recipeRunId)) ??
    firstAvailableRecipeRunId(recipeRuns)
  );
}

export function selectedRecipeRun<RecipeRun extends RecipeRunIdLike>(
  recipeRuns: readonly RecipeRun[],
  selectedRecipeRunId: string,
): RecipeRun | null {
  if (recipeRuns.length === 0) return null;
  return recipeRuns.find((group) => group.id === selectedRecipeRunId) ?? recipeRuns[0] ?? null;
}
