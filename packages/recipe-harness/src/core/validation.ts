import {
  type RecipeActionManifestDocument,
  type RecipeDocumentValidationOptions,
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
  options?: RecipeDocumentValidationOptions,
): void {
  const result = validateRecipeWithManifest(recipe, manifest, options);
  if (result.status === 'invalid') {
    throw new Error(
      `Recipe is invalid for the action manifest: ${result.findings
        .map((finding) => `${finding.code} ${finding.path}: ${finding.message}`)
        .join('; ')}`,
    );
  }
}
