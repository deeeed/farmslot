import type { ArtifactRef } from '@farmslot/protocol';

import { isPackageSelectableEvidenceArtifact } from './draft-pr.js';
import { type EvidenceManifest, evidenceManifestArtifactPaths } from './evidence-manifest.js';
import { isUploadableMediaPath, resolveSelectedEvidenceRef } from './evidence-paths.js';

export interface PublicationEvidenceSelection {
  selectedEvidenceKeys: readonly string[] | undefined;
  evidenceManifest: ArtifactRef[];
  trustedEvidenceManifest: EvidenceManifest | null | undefined;
}

export function selectedEvidenceKeysForPublication(input: PublicationEvidenceSelection): string[] {
  return [
    ...new Set(
      (input.selectedEvidenceKeys ?? [])
        .map((key) => resolveSelectedEvidenceRef(key, input.evidenceManifest))
        .filter((artifact): artifact is ArtifactRef =>
          Boolean(
            artifact &&
            isUploadableMediaPath(artifact.path) &&
            (input.trustedEvidenceManifest === undefined ||
              isPackageSelectableEvidenceArtifact(artifact, input.trustedEvidenceManifest)),
          ),
        )
        .map((artifact) => artifact.path),
    ),
  ].sort();
}

const VIDEO_EXTENSION = /\.(mp4|mov|webm)$/i;

export function defaultSelectedEvidenceKeysForPublication(
  input: Omit<PublicationEvidenceSelection, 'selectedEvidenceKeys'>,
): string[] {
  const manifest = input.trustedEvidenceManifest;
  const preferredVideo =
    manifest?.preferred_mode === 'video' || manifest?.videos?.preferred === true;
  const declared = evidenceManifestArtifactPaths(manifest);
  const videoOnly = declared.length > 0 && declared.every((key) => VIDEO_EXTENSION.test(key));
  return input.evidenceManifest
    .filter(
      (artifact) =>
        (!VIDEO_EXTENSION.test(artifact.path) || preferredVideo || videoOnly) &&
        isUploadableMediaPath(artifact.path) &&
        isPackageSelectableEvidenceArtifact(artifact, manifest),
    )
    .map((artifact) => artifact.path)
    .sort();
}

/** A visual package cannot become an evidence-free publication by selecting nothing. */
export function assertPublicationEvidenceSelection(input: PublicationEvidenceSelection): string[] {
  const selected = selectedEvidenceKeysForPublication(input);
  for (const key of input.selectedEvidenceKeys ?? []) {
    if (isUploadableMediaPath(key) && !resolveSelectedEvidenceRef(key, input.evidenceManifest)) {
      throw new Error(`Publication blocked: selected evidence is absent from the package (${key})`);
    }
  }
  const declared = evidenceManifestArtifactPaths(input.trustedEvidenceManifest);
  const visualInventory = input.evidenceManifest.some((artifact) =>
    isUploadableMediaPath(artifact.path),
  );
  if (selected.length === 0 && (visualInventory || declared.length > 0)) {
    throw new Error(
      'Publication blocked: visual evidence is required but none is selected; refresh the package and select its evidence',
    );
  }
  const screenshotsRequired =
    input.trustedEvidenceManifest?.preferred_mode !== 'video' &&
    input.trustedEvidenceManifest?.videos?.preferred !== true &&
    declared.some((key) => !VIDEO_EXTENSION.test(key));
  if (screenshotsRequired && !selected.some((key) => !VIDEO_EXTENSION.test(key))) {
    throw new Error('Publication blocked: the evidence manifest requires screenshots');
  }
  return selected;
}
