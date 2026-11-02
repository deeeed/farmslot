import { isRunArtifactImagePath } from '@farmslot/protocol';
import { buildArtifactUrlResolver, isHtmlArtifactPath } from '@farmslot/review-dispatch';

import { JSON_EXTS, MARKDOWN_EXTS } from '../../utils/artifact-file-types.js';
import type { HtmlArtifactTarget } from '../../utils/artifact-html.js';
import { buildHash } from '../../utils/url-state.js';
import { runDetailEvidenceArtifactHash } from '../runs/run-detail-url-state.js';

import type { LightboxItem } from './media-lightbox-types.js';

/** A report may be the gallery's only item; its retained inventory still names its videos. */
export function lightboxReportArtifactResolver(
  document: LightboxItem | undefined,
  items: readonly LightboxItem[],
  baseUrl: string,
): (rawPath: string) => HtmlArtifactTarget | null {
  const byPath = new Map(items.map((item) => [item.path, item]));
  const paths = [
    ...byPath.keys(),
    ...(document?.evidenceModel?.report?.artifactManifest ?? []).map((file) => file.path),
  ];
  const resolve = buildArtifactUrlResolver(paths, (path) => path, document?.path);
  return (rawPath) => {
    const path = resolve(rawPath);
    if (!path) return null;
    const item = byPath.get(path);
    const mediaUrl = document?.resolveArtifactUrl?.(path) ?? item?.url;
    if (!mediaUrl || !URL.canParse(mediaUrl, baseUrl)) return null;
    const source = new URL(mediaUrl, baseUrl);
    const runId = source.searchParams.get('runId');
    if (!runId) return item?.viewUrl ? { viewUrl: item.viewUrl } : null;
    const params = new URLSearchParams();
    const recipeRun = source.searchParams.get('recipeRunId');
    if (recipeRun) params.set('recipeRun', recipeRun);
    return {
      viewUrl: new URL(
        runDetailEvidenceArtifactHash(runId, { path }, buildHash('', params)),
        baseUrl,
      ).href,
    };
  };
}

export type LightboxFileType =
  | 'image'
  | 'video'
  | 'html'
  | 'markdown'
  | 'json'
  | 'diff'
  | 'log'
  | 'file';

const VIDEO_EXTS = /\.(mp4|mov|webm)$/i;
const IMAGE_PURPOSES = new Set(['screenshot', 'debug-screenshot']);
const VIDEO_PURPOSES = new Set(['video', 'video-before', 'video-after']);
const DIFF_EXTS = /(?:^|\/)(?:diff\.txt|.*\.(?:diff|patch))$/i;

export interface LightboxTypedItem {
  path: string;
  purpose: string;
}

export function isImageLightboxItem(item: LightboxTypedItem): boolean {
  return isRunArtifactImagePath(item.path) || IMAGE_PURPOSES.has(item.purpose);
}

export function isVideoLightboxItem(item: LightboxTypedItem): boolean {
  return VIDEO_EXTS.test(item.path) || VIDEO_PURPOSES.has(item.purpose);
}

export function mediaLightboxFileType(item: LightboxTypedItem): LightboxFileType {
  // Keep image/video ahead of content-extension checks: legacy filmstrip code
  // treated media purposes as media even when the artifact path was generic.
  if (isImageLightboxItem(item)) return 'image';
  if (isVideoLightboxItem(item)) return 'video';
  if (isHtmlArtifactPath(item.path)) return 'html';
  if (MARKDOWN_EXTS.test(item.path)) return 'markdown';
  if (JSON_EXTS.test(item.path)) return 'json';
  if (DIFF_EXTS.test(item.path) || item.purpose.includes('diff')) return 'diff';
  if (/\.log$/i.test(item.path)) return 'log';
  return 'file';
}

export function mediaLightboxFileTypeBadge(type: LightboxFileType): string {
  switch (type) {
    case 'image':
      return 'IMAGE';
    case 'video':
      return 'VIDEO';
    case 'markdown':
      return 'MD';
    case 'html':
      return 'HTML';
    case 'json':
      return 'JSON';
    case 'diff':
      return 'DIFF';
    case 'log':
      return 'LOG';
    case 'file':
      return 'FILE';
  }
}
