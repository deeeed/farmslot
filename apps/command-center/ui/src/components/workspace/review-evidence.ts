import type { ArtifactRef } from '@farmslot/protocol';

import { isVisualRecipeArtifact } from '../slot-view/slot-view-recipe-helpers.js';

/**
 * Review workers often write screenshots under artifacts/screenshots/. The
 * generic artifact inference marks those as `debug-screenshot` to keep noisy
 * setup captures out of PR publication, but in the review gate they are still
 * the visual proof behind the review text. Use the shared visual-artifact
 * detector instead of purpose-only filtering so the review workspace exposes
 * the same evidence users see in the recipe/ready panels.
 */
export function reviewEvidenceArtifacts(manifest: ArtifactRef[] | null | undefined): ArtifactRef[] {
  return (manifest ?? []).filter((artifact) => isVisualRecipeArtifact(artifact));
}
