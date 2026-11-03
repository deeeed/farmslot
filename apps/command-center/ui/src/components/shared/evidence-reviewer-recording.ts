import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

import type { EvidenceReviewerSelection } from './evidence-reviewer.js';
import { isVideoLightboxItem } from './media-lightbox-model.js';
import type { LightboxItem } from './media-lightbox-types.js';

/**
 * The review for one criterion of a run: its recording (the opened one, else the
 * run's first) and the file the user chose. Every host opens the review through this.
 */
export function evidenceReviewerSelection(input: {
  model: EvidenceReviewModel;
  claimId: string;
  resolveUrl: (path: string) => string;
  opened?: LightboxItem;
}): EvidenceReviewerSelection {
  const { model, resolveUrl } = input;
  const original = model.claimMedia(input.claimId).recording;
  // A video from another recipe run would carry that run's trace markers: open the
  // model's own recording. Hosts rebuild the selection as the model loads.
  const opened =
    input.opened &&
    isVideoLightboxItem(input.opened) &&
    (original || model.recordings.length > 0) &&
    !model.recordingForPath(input.opened.path)
      ? undefined
      : input.opened;
  const path = original?.artifactPath ?? null;
  const recording =
    opened && isVideoLightboxItem(opened)
      ? opened
      : path
        ? {
            url: resolveUrl(path),
            path,
            purpose: 'recording',
            evidenceModel: model,
            resolveArtifactUrl: resolveUrl,
          }
        : null;
  return { claimId: input.claimId, model, recording, resolveUrl, opened };
}
