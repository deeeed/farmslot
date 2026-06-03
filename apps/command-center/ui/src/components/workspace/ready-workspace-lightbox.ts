import type { ArtifactRef, RecipeRunArtifactGroup } from '@farmslot/protocol';

import { artifactLightboxItems, artifactLightboxPairs } from '../shared/artifact-lightbox-model.js';
import type { LightboxItem, LightboxPair } from '../shared/media-lightbox-types.js';

import { JSON_EXTS, MARKDOWN_EXTS, MEDIA_EXTS, VIDEO_EXTS } from './workspace-artifacts.js';

export function selectedReadyWorkspaceLightboxRecipeRun(
  recipeRuns: readonly RecipeRunArtifactGroup[],
  lightboxRecipeRunId: string | null,
): RecipeRunArtifactGroup | null {
  if (!lightboxRecipeRunId) return null;
  return recipeRuns.find((group) => group.id === lightboxRecipeRunId) ?? null;
}

export function readyWorkspaceLightboxSourceArtifacts(args: {
  recipeRuns: readonly RecipeRunArtifactGroup[];
  lightboxRecipeRunId: string | null;
  allArtifacts: readonly ArtifactRef[];
  scopePaths: readonly string[] | null;
}): ArtifactRef[] {
  const recipeRun = selectedReadyWorkspaceLightboxRecipeRun(
    args.recipeRuns,
    args.lightboxRecipeRunId,
  );
  const artifacts = recipeRun?.artifactManifest ?? args.allArtifacts;
  if (!args.scopePaths?.length) return [...artifacts];
  const scope = new Set(args.scopePaths);
  return artifacts.filter((artifact) => scope.has(artifact.path));
}

export function readyWorkspaceOpensInLightbox(artifact: Pick<ArtifactRef, 'path'>): boolean {
  return (
    MEDIA_EXTS.test(artifact.path) ||
    MARKDOWN_EXTS.test(artifact.path) ||
    JSON_EXTS.test(artifact.path)
  );
}

export function readyWorkspaceLightboxItems(
  sourceArtifacts: readonly ArtifactRef[],
  artifactUrl: (artifact: ArtifactRef) => string,
): LightboxItem[] {
  return artifactLightboxItems(sourceArtifacts, artifactUrl, readyWorkspaceOpensInLightbox);
}

export function readyWorkspaceLightboxPairs(
  sourceArtifacts: readonly ArtifactRef[],
  artifactUrl: (artifact: ArtifactRef) => string,
): LightboxPair[] {
  return artifactLightboxPairs(
    sourceArtifacts,
    artifactUrl,
    (artifact) => MEDIA_EXTS.test(artifact.path),
    (artifact) => VIDEO_EXTS.test(artifact.path),
  );
}
