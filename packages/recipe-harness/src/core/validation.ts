import {
  type RecipeActionManifestDocument,
  validateRecipeActionManifestDocument,
  validateRecipeWithManifest,
} from '@farmslot/protocol';

export function assertManifestIsValid(
  manifest: unknown,
): asserts manifest is RecipeActionManifestDocument {
  const result = validateRecipeActionManifestDocument(manifest);
  if (result.status === 'invalid') {
    throw new Error(
      `Recipe action manifest is invalid: ${result.findings
        .map((finding) => `${finding.code} ${finding.path}: ${finding.message}`)
        .join('; ')}`,
    );
  }
}

export function assertRecipeMatchesManifest(
  recipe: unknown,
  manifest: RecipeActionManifestDocument,
): void {
  const result = validateRecipeWithManifest(recipe, manifest);
  if (result.status === 'invalid') {
    throw new Error(
      `Recipe is invalid for the action manifest: ${result.findings
        .map((finding) => `${finding.code} ${finding.path}: ${finding.message}`)
        .join('; ')}`,
    );
  }
}
