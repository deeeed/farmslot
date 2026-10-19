import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type { ArtifactRef, RecipeRunArtifactGroup } from '@farmslot/protocol';
import { isRunArtifactMediaPath } from '@farmslot/protocol';

import { artifactLightboxItems, artifactLightboxPairs } from '../shared/artifact-lightbox-model.js';
import { mediaLightboxFileType } from '../shared/media-lightbox-model.js';
import type { LightboxItem, LightboxPair } from '../shared/media-lightbox-types.js';

import { JSON_EXTS, MARKDOWN_EXTS, VIDEO_EXTS } from './workspace-artifacts.js';

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
    isRunArtifactMediaPath(artifact.path) ||
    MARKDOWN_EXTS.test(artifact.path) ||
    JSON_EXTS.test(artifact.path) ||
    mediaLightboxFileType({ path: artifact.path, purpose: '' }) === 'log'
  );
}

export function readyWorkspaceLightboxItems(
  sourceArtifacts: readonly ArtifactRef[],
  artifactUrl: (artifact: ArtifactRef) => string,
  model?: EvidenceReviewModel | null,
): LightboxItem[] {
  return artifactLightboxItems(sourceArtifacts, artifactUrl, readyWorkspaceOpensInLightbox, model);
}

export function readyWorkspaceLightboxPairs(
  sourceArtifacts: readonly ArtifactRef[],
  artifactUrl: (artifact: ArtifactRef) => string,
  model?: EvidenceReviewModel | null,
): LightboxPair[] {
  return artifactLightboxPairs(
    sourceArtifacts,
    artifactUrl,
    (artifact) => isRunArtifactMediaPath(artifact.path),
    (artifact) => VIDEO_EXTS.test(artifact.path),
    model,
  );
}
