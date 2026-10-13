import { readdir } from 'node:fs/promises';

// Observer setup may already exist here, but a recipe package belongs to one attempt.
const PACKAGE_FILES = new Set([
  'recipe.json',
  'recipe-invocation.json',
  'recipe-resolution.json',
  'summary.json',
  'trace.json',
  'artifact-manifest.json',
  'evidence-manifest.json',
  'acceptance-status.json',
]);

export function occupiedRecipeArtifactsError(artifactsDir: string): Error {
  return new Error(
    `Recipe artifact directory already contains a retained attempt: ${artifactsDir}. ` +
      'Choose a fresh artifactsDir or --artifacts-dir for the new attempt; keep the existing evidence.',
  );
}

export async function assertRecipeArtifactDestinationAvailable(
  artifactsDir: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(artifactsDir);
  } catch (error) {
    // Preflight does not create the destination. A new directory is available.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entries.some((entry) => PACKAGE_FILES.has(entry))) {
    throw occupiedRecipeArtifactsError(artifactsDir);
  }
}
