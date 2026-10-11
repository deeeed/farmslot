import { type ArtifactRef, isPublishEvidenceArtifact } from '@farmslot/protocol';

import {
  EVIDENCE_VIDEO_EXT,
  type EvidenceManifest,
  evidenceManifestArtifactPaths,
  manifestPrefersVideo,
} from './evidence-manifest.js';
import {
  exactEvidenceKeys,
  isUploadableMediaPath,
  resolveSelectedEvidenceRef,
} from './evidence-paths.js';

export interface PublicationEvidenceSelection {
  selectedEvidenceKeys: readonly string[] | undefined;
  evidenceManifest: ArtifactRef[];
  trustedEvidenceManifest: EvidenceManifest | null | undefined;
}

export function isEvidenceManifestReferencedArtifact(
  artifactPath: string,
  manifest: EvidenceManifest | null | undefined,
): boolean {
  const referenced = new Set(evidenceManifestArtifactPaths(manifest).flatMap(exactEvidenceKeys));
  return exactEvidenceKeys(artifactPath).some((variant) => referenced.has(variant));
}

export function isPackageSelectableEvidenceArtifact(
  artifact: Pick<ArtifactRef, 'path' | 'purpose'>,
  manifest: EvidenceManifest | null | undefined,
): boolean {
  return (
    isPublishEvidenceArtifact(artifact) ||
    isEvidenceManifestReferencedArtifact(artifact.path, manifest)
  );
}

/** Inventories have already passed the package evidence filter. */
function isEligibleEvidence(
  artifact: ArtifactRef,
  manifest: EvidenceManifest | null | undefined,
): boolean {
  return (
    isUploadableMediaPath(artifact.path) && isPackageSelectableEvidenceArtifact(artifact, manifest)
  );
}

/** Ungated completion has no operator selector, so retain every selectable recording. */
export function allSelectedEvidenceKeysForPublication(inventory: ArtifactRef[]): string[] {
  return inventory
    .filter((artifact) => isUploadableMediaPath(artifact.path))
    .map((artifact) => artifact.path)
    .sort();
}

export function publicationEvidenceChangedError(_runId: string, detail: string): Error {
  return new Error(`Publication blocked: ${detail}; regenerate the evidence and retry`);
}

export function selectedEvidenceKeysForPublication(input: PublicationEvidenceSelection): string[] {
  return [
    ...new Set(
      (input.selectedEvidenceKeys ?? [])
        .map((key) => resolveSelectedEvidenceRef(key, input.evidenceManifest))
        .filter((artifact): artifact is ArtifactRef =>
          Boolean(artifact && isEligibleEvidence(artifact, input.trustedEvidenceManifest)),
        )
        .map((artifact) => artifact.path),
    ),
  ].sort();
}

export function defaultSelectedEvidenceKeysForPublication(
  input: Omit<PublicationEvidenceSelection, 'selectedEvidenceKeys'>,
): string[] {
  const manifest = input.trustedEvidenceManifest;
  const preferredVideo = manifestPrefersVideo(manifest);
  const candidates = input.evidenceManifest.filter((artifact) =>
    isEligibleEvidence(artifact, input.trustedEvidenceManifest),
  );
  const videoOnly =
    candidates.length > 0 && candidates.every((artifact) => EVIDENCE_VIDEO_EXT.test(artifact.path));
  return candidates
    .filter((artifact) => !EVIDENCE_VIDEO_EXT.test(artifact.path) || preferredVideo || videoOnly)
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
    isEligibleEvidence(artifact, input.trustedEvidenceManifest),
  );
  if (selected.length === 0 && (visualInventory || declared.length > 0)) {
    throw new Error(
      'Publication blocked: visual evidence is required but none is selected; refresh the package and select its evidence',
    );
  }
  const screenshotsRequired =
    !manifestPrefersVideo(input.trustedEvidenceManifest) &&
    declared.some((key) => !EVIDENCE_VIDEO_EXT.test(key));
  if (screenshotsRequired && !selected.some((key) => !EVIDENCE_VIDEO_EXT.test(key))) {
    throw new Error('Publication blocked: the evidence manifest requires screenshots');
  }
  return selected;
}
