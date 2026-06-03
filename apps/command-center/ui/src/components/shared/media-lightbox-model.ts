import { JSON_EXTS, MARKDOWN_EXTS } from '../../utils/artifact-file-types.js';

export type LightboxFileType = 'image' | 'video' | 'markdown' | 'json' | 'diff' | 'file';

const IMAGE_EXTS = /\.(png|jpg|jpeg|gif)$/i;
const VIDEO_EXTS = /\.(mp4|mov|webm)$/i;
const IMAGE_PURPOSES = new Set(['screenshot', 'debug-screenshot']);
const VIDEO_PURPOSES = new Set(['video', 'video-before', 'video-after']);
const DIFF_EXTS = /(?:^|\/)(?:diff\.txt|.*\.(?:diff|patch))$/i;

export interface LightboxTypedItem {
  path: string;
  purpose: string;
}

export function isImageLightboxItem(item: LightboxTypedItem): boolean {
  return IMAGE_EXTS.test(item.path) || IMAGE_PURPOSES.has(item.purpose);
}

export function isVideoLightboxItem(item: LightboxTypedItem): boolean {
  return VIDEO_EXTS.test(item.path) || VIDEO_PURPOSES.has(item.purpose);
}

export function mediaLightboxFileType(item: LightboxTypedItem): LightboxFileType {
  // Keep image/video ahead of content-extension checks: legacy filmstrip code
  // treated media purposes as media even when the artifact path was generic.
  if (isImageLightboxItem(item)) return 'image';
  if (isVideoLightboxItem(item)) return 'video';
  if (MARKDOWN_EXTS.test(item.path)) return 'markdown';
  if (JSON_EXTS.test(item.path)) return 'json';
  if (DIFF_EXTS.test(item.path) || item.purpose.includes('diff')) return 'diff';
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
    case 'json':
      return 'JSON';
    case 'diff':
      return 'DIFF';
    case 'file':
      return 'FILE';
  }
}
