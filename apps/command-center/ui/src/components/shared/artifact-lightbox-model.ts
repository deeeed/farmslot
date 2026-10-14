import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import type { ArtifactRef } from '@farmslot/protocol';

import { buildBeforeAfterPairs } from '../../utils/artifact-pairs.js';

import type { LightboxItem, LightboxPair } from './media-lightbox-types.js';

type LightboxArtifact = Pick<
  ArtifactRef,
  'path' | 'purpose' | 'sha256' | 'timelinePath' | 'timelineUnavailableReason'
>;

export function artifactLightboxItem<T extends LightboxArtifact>(
  artifact: T,
  artifactUrl: (artifact: T) => string,
  model?: EvidenceReviewModel | null,
): LightboxItem {
  return {
    ...(model ? { evidenceModel: model } : {}),
    url: artifactUrl(artifact),
    path: artifact.path,
    purpose: artifact.purpose,
    ...(artifact.timelinePath
      ? {
          sha256: artifact.sha256,
          timelinePath: artifact.timelinePath,
          resolveArtifactUrl: (path: string) =>
            artifactUrl({ ...artifact, path, sha256: undefined }),
        }
      : {}),
    ...(artifact.timelineUnavailableReason
      ? { timelineUnavailableReason: artifact.timelineUnavailableReason }
      : {}),
  };
}

export function artifactLightboxItems<T extends LightboxArtifact>(
  sourceArtifacts: readonly T[],
  artifactUrl: (artifact: T) => string,
  opensInLightbox: (artifact: T) => boolean,
  model?: EvidenceReviewModel | null,
): LightboxItem[] {
  return sourceArtifacts
    .filter(opensInLightbox)
    .map((artifact) => artifactLightboxItem(artifact, artifactUrl, model));
}

export function artifactLightboxPairs<T extends LightboxArtifact>(
  sourceArtifacts: readonly T[],
  artifactUrl: (artifact: T) => string,
  pairable: (artifact: T) => boolean,
  isVideo: (artifact: T) => boolean,
  model?: EvidenceReviewModel | null,
): LightboxPair[] {
  return buildBeforeAfterPairs(sourceArtifacts.filter(pairable), model).map((pair) => ({
    before: artifactLightboxItem(pair.before, artifactUrl, model),
    after: artifactLightboxItem(pair.after, artifactUrl, model),
    stem: pair.stem,
    kind: isVideo(pair.before) ? 'video' : 'image',
  }));
}
