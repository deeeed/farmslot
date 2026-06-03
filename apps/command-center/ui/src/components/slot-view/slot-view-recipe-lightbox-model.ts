import type { ArtifactRef } from '@farmslot/protocol';

import { artifactKind } from '../../utils/artifact-kind.js';
import { artifactLightboxItems, artifactLightboxPairs } from '../shared/artifact-lightbox-model.js';
import type { LightboxItem, LightboxPair } from '../shared/media-lightbox-types.js';

import { isVideoRecipeArtifact, isVisualRecipeArtifact } from './slot-view-recipe-helpers.js';

export function scopedSlotViewRecipeArtifacts(
  artifacts: readonly ArtifactRef[],
  scopePaths: readonly string[] | null,
): ArtifactRef[] {
  if (!scopePaths?.length) return [...artifacts];
  const scope = new Set(scopePaths);
  return artifacts.filter((artifact) => scope.has(artifact.path));
}

export function slotViewRecipeLightboxItems(args: {
  artifacts: readonly ArtifactRef[];
  scopePaths: readonly string[] | null;
  kindFilter: string;
  artifactUrl: (artifact: ArtifactRef) => string;
}): LightboxItem[] {
  const scopedArtifacts = scopedSlotViewRecipeArtifacts(args.artifacts, args.scopePaths);
  return artifactLightboxItems(
    scopedArtifacts,
    args.artifactUrl,
    (artifact) =>
      (isVisualRecipeArtifact(artifact) || /\.(md|markdown)$/i.test(artifact.path)) &&
      (args.kindFilter === 'all' ||
        artifactKind(artifact.path, artifact.purpose) === args.kindFilter),
  );
}

export function slotViewRecipeLightboxPairs(args: {
  artifacts: readonly ArtifactRef[];
  scopePaths: readonly string[] | null;
  artifactUrl: (artifact: ArtifactRef) => string;
}): LightboxPair[] {
  return artifactLightboxPairs(
    scopedSlotViewRecipeArtifacts(args.artifacts, args.scopePaths),
    args.artifactUrl,
    isVisualRecipeArtifact,
    isVideoRecipeArtifact,
  );
}

export function clearedSlotViewRecipeLightboxScopeIndex(
  items: readonly Pick<LightboxItem, 'path'>[],
  path?: string | null,
): number | null {
  if (!path) return null;
  const index = items.findIndex((item) => item.path === path);
  return index >= 0 ? index : null;
}
