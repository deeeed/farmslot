import type { EvidenceReviewModel } from '@farmslot/adapter-sdk/evidence';
import {
  type ArtifactRef,
  isPublishEvidenceArtifact,
  isRunArtifactImagePath,
  isRunArtifactMediaPath,
  type RecipeRunArtifactGroup,
  withArtifactBundleDigest,
} from '@farmslot/protocol';

import { artifactKind } from '../../utils/artifact-kind.js';
import { gatewayResourceUrl } from '../../utils/gateway-origin.js';
export type ArtifactGroup = 'before' | 'after' | 'review' | 'other';
export type ArtifactFilter = 'all' | ArtifactGroup;
export type ArtifactTypeFilter = 'all' | 'image' | 'video' | 'markdown' | 'json' | 'diff' | 'other';

export const VIDEO_EXTS = /\.(mp4|mov|webm)$/i;
export const DIFF_EXTS = /(?:^|\/)(?:diff\.txt|.*\.diff)$/i;
export const MARKDOWN_EXTS = /\.(md|markdown)$/i;
export const JSON_EXTS = /\.json$/i;

export function workspaceArtifactBasename(path: string, fallback = path): string {
  return path.split('/').pop() ?? fallback;
}

export function isWorkspaceDiffArtifact(artifact: Pick<ArtifactRef, 'path' | 'purpose'>): boolean {
  return DIFF_EXTS.test(artifact.path) || artifact.purpose.includes('diff');
}

/** Internal path template — always pair with gatewayAuthenticatedUrl or gatewayProxiedFetchUrl. */
export function runArtifactApiPath(
  runId: string,
  artifact: Pick<ArtifactRef, 'path' | 'sha256' | 'bundleDigest'>,
): string {
  return withArtifactBundleDigest(
    `/api/run-artifact?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(
      artifact.path,
    )}${artifact.sha256 ? `&v=${encodeURIComponent(artifact.sha256)}` : ''}`,
    artifact.bundleDigest,
  );
}

export function runArtifactFetchUrl(
  runId: string,
  artifact: Pick<ArtifactRef, 'path' | 'sha256' | 'bundleDigest'>,
): string {
  return gatewayResourceUrl(runArtifactApiPath(runId, artifact));
}

export function runArtifactUrl(
  runId: string,
  artifact: Pick<ArtifactRef, 'path' | 'sha256' | 'bundleDigest'>,
): string {
  return runArtifactFetchUrl(runId, artifact);
}

export function recipeRunArtifactUrl(
  runId: string,
  group: Pick<RecipeRunArtifactGroup, 'id' | 'groupKind' | 'artifactBundle'>,
  artifact: Pick<ArtifactRef, 'path' | 'sha256' | 'sizeBytes' | 'bundleDigest'>,
): string {
  const params = new URLSearchParams({ runId, path: artifact.path });
  if (group.groupKind !== 'current-artifacts') params.set('recipeRunId', group.id);
  if (artifact.sha256) params.set('v', artifact.sha256.slice(0, 12));
  else if (typeof artifact.sizeBytes === 'number') params.set('v', `s${artifact.sizeBytes}`);
  if (typeof artifact.sizeBytes === 'number') params.set('vsize', String(artifact.sizeBytes));
  return gatewayResourceUrl(
    withArtifactBundleDigest(
      `/api/run-artifact?${params.toString()}`,
      artifact.bundleDigest ?? group.artifactBundle?.bundleDigest,
    ),
  );
}

export function workspaceArtifactGroup(
  artifact: Pick<ArtifactRef, 'path' | 'purpose'>,
  model?: EvidenceReviewModel | null,
): ArtifactGroup {
  const role = model?.artifactRole(artifact.path);
  if (role === 'review') return role;
  if (!isRunArtifactMediaPath(artifact.path) && artifact.purpose.toLowerCase().includes('review'))
    return 'review';
  const kind = artifactKind(artifact.path, artifact.purpose, model);
  if (kind === 'before' || kind === 'after') return kind;
  return 'other';
}

export function workspaceArtifactGroupLabel(group: ArtifactGroup): string {
  switch (group) {
    case 'before':
      return 'Before evidence';
    case 'after':
      return 'After evidence';
    case 'review':
      return 'Review artifacts';
    case 'other':
      return 'Unassigned and supporting artifacts';
  }
}

export function workspaceArtifactType(
  artifact: Pick<ArtifactRef, 'path' | 'purpose'>,
): ArtifactTypeFilter {
  if (isRunArtifactImagePath(artifact.path)) return 'image';
  if (VIDEO_EXTS.test(artifact.path)) return 'video';
  if (MARKDOWN_EXTS.test(artifact.path)) return 'markdown';
  if (JSON_EXTS.test(artifact.path)) return 'json';
  if (isWorkspaceDiffArtifact(artifact)) return 'diff';
  return 'other';
}

export function workspaceArtifactTypeLabel(type: ArtifactTypeFilter): string {
  switch (type) {
    case 'all':
      return 'All types';
    case 'image':
      return 'Images';
    case 'video':
      return 'Videos';
    case 'markdown':
      return 'Markdown';
    case 'json':
      return 'JSON';
    case 'diff':
      return 'Diffs';
    case 'other':
      return 'Other files';
  }
}

export function workspaceArtifactTypeBadge(type: ArtifactTypeFilter): string {
  switch (type) {
    case 'image':
      return 'IMAGE';
    case 'video':
      return 'VIDEO';
    case 'markdown':
      return 'MD';
    case 'json':
      return 'JSON';
    case 'diff':
      return 'DIFF';
    case 'other':
      return 'FILE';
    case 'all':
      return 'FILE';
  }
}

export function isDebugScreenshotArtifact(
  artifact: Pick<ArtifactRef, 'path' | 'purpose'>,
): boolean {
  const normalizedPath = artifact.path.replace(/\\/g, '/').toLowerCase();
  return (
    artifact.purpose?.toLowerCase() === 'debug-screenshot' ||
    /(^|\/)screenshots\//.test(normalizedPath)
  );
}

export function isWorkspaceEvidenceArtifact(
  artifact: Pick<ArtifactRef, 'path' | 'purpose'>,
): boolean {
  return isPublishEvidenceArtifact(artifact);
}
