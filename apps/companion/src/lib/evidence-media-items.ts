import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';

import type { MediaViewerItem } from '../components/MediaViewer';

import {
  type ArtifactHttpHeaders,
  type ArtifactManifestEntry,
  artifactUrl,
  classifyArtifact,
  CURRENT_ARTIFACTS_RECIPE_RUN_PARAM,
} from './artifact-url';

/** Keep the model's captured bundle and distinguish task paths from selected-root refs. */
export function recordedEvidenceArtifactUrl(
  gatewayUrl: string,
  runId: string,
  model: EvidenceReviewModel,
  path: string,
): string {
  return artifactUrl(
    gatewayUrl,
    runId,
    path,
    model.report?.artifactManifest.some((entry) => entry.path === path)
      ? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM
      : undefined,
    undefined,
    model.report?.artifactBundle?.bundleDigest,
  );
}

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

/** Original recordings match their whole checked artifact identity, never a shared filename. */
export function evidenceRecordingForPath(model: EvidenceReviewModel, path: string | undefined) {
  return model.recordings.find((recording) => path === model.artifactPath(recording.videoPath));
}

export function selectedEvidenceMediaItem(
  model: EvidenceReviewModel,
  path: string,
  resolveArtifactUrl: (path: string) => string,
  authHeaders: ArtifactHttpHeaders,
): MediaViewerItem {
  return {
    uri: resolveArtifactUrl(path),
    path,
    title: model.selection?.caption,
    mediaType:
      model.selection?.artifacts.find((artifact) => artifact.artifactPath === path)?.mediaType ??
      classifyArtifact(path),
    evidenceModel: model,
    initialTraceIndex: model.playback.clip?.traceIndex,
    authHeaders,
    resolveArtifactUrl,
  };
}

/** Resolve visibility and navigation from the same media list, including a selected moment. */
export function evidenceViewerSelection(
  uri: string | null,
  artifacts: MediaViewerItem[],
  comparison: MediaViewerItem[] | null,
): { items: MediaViewerItem[]; index: number } {
  if (uri && comparison?.some((item) => item.uri === uri))
    return { items: comparison, index: comparison.findIndex((item) => item.uri === uri) };
  return { items: artifacts, index: uri ? artifacts.findIndex((item) => item.uri === uri) : -1 };
}
