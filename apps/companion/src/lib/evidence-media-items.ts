import type {
  EvidenceReviewModel,
  EvidenceReviewPlaybackEffect,
} from '@farmslot/adapter-sdk/evidence';
import type { SharedRunArtifactOwner } from '@farmslot/protocol/surfaces/view-links';

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
  model: EvidenceReviewModel | null | undefined,
  pathOrArtifact: string | ArtifactManifestEntry,
): string {
  const artifact: ArtifactManifestEntry =
    typeof pathOrArtifact === 'string'
      ? { path: pathOrArtifact, purpose: 'evidence' }
      : pathOrArtifact;
  return artifactUrl(
    gatewayUrl,
    runId,
    artifact.path,
    artifact.recipeRunId ??
      (model?.report?.artifactManifest.some((entry) => entry.path === artifact.path)
        ? CURRENT_ARTIFACTS_RECIPE_RUN_PARAM
        : undefined),
    undefined,
    artifact.bundleDigest ?? model?.report?.artifactBundle?.bundleDigest,
  );
}

/** Native transport adapter. Captions and range selection belong to the shared SDK model. */
export function evidenceMediaItems(
  artifacts: readonly ArtifactManifestEntry[],
  urlFor: (artifact: ArtifactManifestEntry) => string,
  authHeaders: ArtifactHttpHeaders,
  evidenceModel?: EvidenceReviewModel | null,
  sharedOwner?: SharedRunArtifactOwner,
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
        ...(sharedOwner
          ? {
              sharedArtifact: {
                ...sharedOwner,
                path: artifact.path,
                recipeRunId:
                  artifact.recipeRunId &&
                  artifact.recipeRunId !== CURRENT_ARTIFACTS_RECIPE_RUN_PARAM
                    ? artifact.recipeRunId
                    : sharedOwner.recipeRunId,
              },
            }
          : {}),
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
  sharedOwner?: SharedRunArtifactOwner,
): MediaViewerItem {
  const claim = model.claims.find(({ id }) => id === model.selection?.claimId);
  return {
    uri: resolveArtifactUrl(path),
    path,
    title: claim ? `${claim.id}: ${claim.text}` : model.selection?.caption,
    mediaType:
      model.selection?.artifacts.find((artifact) => artifact.artifactPath === path)?.mediaType ??
      classifyArtifact(path),
    evidenceModel: model,
    initialTraceIndex: model.playback.clip?.traceIndex,
    ...(sharedOwner
      ? { sharedArtifact: { ...sharedOwner, path, traceIndex: model.playback.clip?.traceIndex } }
      : {}),
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

export { mediaShareView } from './media-share-view';

/**
 * Moving a recording's review to another criterion: select it, cue its clip on this
 * recording, and play from `startMs`, its moment in the table of contents (else the clip's
 * start). Undefined when the run has no such criterion; a null effect when it has nothing
 * to play here, so only the caption changes.
 */
export function evidenceClaimPlayback(
  model: EvidenceReviewModel,
  claimId: string,
  videoPath: string,
  startMs: number | null,
): { effect: EvidenceReviewPlaybackEffect | null } | undefined {
  if (!model.selectClaim(claimId)) return undefined;
  const clipIndex = model.selection?.clips.findIndex((clip) => clip.videoPath === videoPath) ?? -1;
  const cued = clipIndex >= 0 ? model.cueClip(clipIndex) : null;
  const seekMs = startMs ?? cued?.seekMs ?? null;
  return {
    effect:
      seekMs === null
        ? null
        : { clip: cued?.clip ?? null, sourceChanged: false, pause: false, seekMs },
  };
}
