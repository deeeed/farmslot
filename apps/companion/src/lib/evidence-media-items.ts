import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

import type { MediaViewerItem } from '../components/MediaViewer';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  classifyArtifact,
} from './artifact-url';

/** Native transport adapter. Captions and range selection belong to the shared SDK model. */
export function evidenceMediaItems(
  artifacts: readonly ArtifactManifestEntry[],
  urlFor: (artifact: ArtifactManifestEntry) => string,
  authHeaders: ArtifactHttpHeaders,
  evidenceModel?: EvidenceReviewModel | null,
): MediaViewerItem[] {
  const seen = new Set<string>();
  return artifacts.flatMap((artifact) => {
    const mediaType = classifyArtifact(artifact);
    if (mediaType !== 'image' && mediaType !== 'video') return [];
    const uri = urlFor(artifact);
    if (seen.has(uri)) return [];
    seen.add(uri);
    return [
      {
        uri,
        title: artifact.label ?? artifact.path,
        path: artifact.path,
        mediaType,
        authHeaders,
        sha256: artifact.sha256,
        timelinePath: artifact.timelinePath,
        resolveArtifactUrl: (path) => urlFor({ ...artifact, path }),
        evidenceModel: evidenceModel ?? undefined,
      },
    ];
  });
}
