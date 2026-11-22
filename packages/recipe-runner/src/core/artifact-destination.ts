import { readdir } from 'node:fs/promises';
import path from 'node:path';

export const RECIPE_PENDING_FLOW_FILE = '.farmslot-recipe-flow.json';
export const RECIPE_PENDING_FLOW_PARTIAL_FILE = `${RECIPE_PENDING_FLOW_FILE}.partial`;

function isPendingFlowArtifact(relativePath: string): boolean {
  const file = path.normalize(relativePath).toLowerCase();
  return file === RECIPE_PENDING_FLOW_FILE || file === RECIPE_PENDING_FLOW_PARTIAL_FILE;
}

export function assertNotPendingFlowArtifact(relativePath: string): void {
  if (isPendingFlowArtifact(relativePath)) {
    throw new Error(`Artifact path ${relativePath} is reserved for pending recipe flow.`);
  }
}

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
  if (entries.some((entry) => PACKAGE_FILES.has(entry) || isPendingFlowArtifact(entry))) {
    throw occupiedRecipeArtifactsError(artifactsDir);
  }
}
