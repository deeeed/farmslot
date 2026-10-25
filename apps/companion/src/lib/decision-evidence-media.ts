import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

import type { MediaViewerItem } from '../components/MediaViewer';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  classifyArtifact,
  type VisualArtifactPair,
} from './artifact-url';
import { evidenceMediaItems, recordedEvidenceArtifactUrl } from './evidence-media-items';

interface DecisionEvidenceMediaInput {
  runId?: string | null;
  slotId?: string;
  gatewayUrl: string;
  artifacts: readonly ArtifactManifestEntry[];
  authHeaders: ArtifactHttpHeaders;
  recordedModel?: EvidenceReviewModel | null;
  evidenceModel?: EvidenceReviewModel | null;
  recipeFallbackPairs: readonly VisualArtifactPair[];
}

/** Keep each displayed file's owning run and recipe identity through the native viewer. */
export function decisionEvidenceMediaItems(input: DecisionEvidenceMediaInput): MediaViewerItem[] {
  const {
    runId,
    slotId,
    gatewayUrl,
    artifacts,
    authHeaders,
    recordedModel,
    evidenceModel,
    recipeFallbackPairs,
  } = input;
  if (!runId) return [];
  const items = evidenceMediaItems(
    artifacts,
    (artifact) => recordedEvidenceArtifactUrl(gatewayUrl, runId, recordedModel, artifact),
    authHeaders,
    evidenceModel,
    { runId, slotId },
  );
  for (const pair of recipeFallbackPairs) {
    for (const artifact of [pair.before, pair.after]) {
      items.push({
        uri: artifact.url,
        title: artifact.label ?? artifact.path,
        mediaType: classifyArtifact(artifact),
        authHeaders,
        sharedArtifact: { runId, slotId, recipeRunId: artifact.recipeRunId, path: artifact.path },
      });
    }
  }
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.uri)) return false;
    seen.add(item.uri);
    return true;
  });
}
