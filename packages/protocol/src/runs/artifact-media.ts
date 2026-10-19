import type { EvidenceManifestEntry } from '../contracts/runs.js';

// A leaf module, so recipes/step-io can share these checks without an import cycle.

export function isRunEvidenceVideoArtifact(entry: Pick<EvidenceManifestEntry, 'path'>): boolean {
  return /\.(mp4|mov|m4v|webm)$/i.test(entry.path);
}

/** Image formats the clients show inline; `isRunEvidenceImageArtifact` also counts ones they can't. */
export function isRunArtifactImagePath(path: string): boolean {
  return /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(path);
}

/** An image the clients show inline, or a video: the media lists of every client and the gateway. */
export function isRunArtifactMediaPath(path: string): boolean {
  return isRunArtifactImagePath(path) || isRunEvidenceVideoArtifact({ path });
}
