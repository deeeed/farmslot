import {
  type EvidenceReviewModel,
  loadRecordingEvidenceReview,
} from '@farmslot/adapter-sdk/evidence';

import type { LightboxItem } from './media-lightbox-types.js';

/** Platform transport only; the SDK owns validation, selection and playback. */
export async function loadLightboxEvidence(
  item: LightboxItem,
  readJson: (url: string) => Promise<unknown>,
): Promise<EvidenceReviewModel> {
  if (item.evidenceModel) return item.evidenceModel;
  if (!item.timelinePath || !item.resolveArtifactUrl || !item.sha256)
    throw new Error(
      item.timelineUnavailableReason ?? 'No verified recording timeline is available.',
    );
  const resolveUrl = item.resolveArtifactUrl;
  return loadRecordingEvidenceReview({
    videoPath: item.path,
    videoDigest: item.sha256,
    timelinePath: item.timelinePath,
    readJson: (path) => readJson(resolveUrl(path)),
  });
}
