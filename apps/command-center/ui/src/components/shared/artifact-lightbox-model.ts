import type { ArtifactRef } from '@farmslot/protocol';

import { buildBeforeAfterPairs } from '../../utils/artifact-pairs.js';

import type { LightboxItem, LightboxPair } from './media-lightbox-types.js';

type LightboxArtifact = Pick<ArtifactRef, 'path' | 'purpose'>;

export function artifactLightboxItem<T extends LightboxArtifact>(
  artifact: T,
  artifactUrl: (artifact: T) => string,
): LightboxItem {
  return {
    url: artifactUrl(artifact),
    path: artifact.path,
    purpose: artifact.purpose,
  };
}

export function artifactLightboxItems<T extends LightboxArtifact>(
  sourceArtifacts: readonly T[],
  artifactUrl: (artifact: T) => string,
  opensInLightbox: (artifact: T) => boolean,
): LightboxItem[] {
  return sourceArtifacts.filter(opensInLightbox).map((artifact) => ({
    url: artifactUrl(artifact),
    path: artifact.path,
    purpose: artifact.purpose,
  }));
}

export function artifactLightboxPairs<T extends LightboxArtifact>(
  sourceArtifacts: readonly T[],
  artifactUrl: (artifact: T) => string,
  pairable: (artifact: T) => boolean,
  isVideo: (artifact: T) => boolean,
): LightboxPair[] {
  return buildBeforeAfterPairs(sourceArtifacts.filter(pairable)).map((pair) => ({
    before: artifactLightboxItem(pair.before, artifactUrl),
    after: artifactLightboxItem(pair.after, artifactUrl),
    stem: pair.stem,
    kind: isVideo(pair.before) ? 'video' : 'image',
  }));
}
