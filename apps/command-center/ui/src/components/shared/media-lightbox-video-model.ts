import type { LightboxItem, LightboxPair } from './media-lightbox-types.js';

export const DEFAULT_VIDEO_FRAME_RATE = 30;

export function mediaLightboxFrameRateForSelection({
  mode,
  item,
  pair,
}: {
  mode: 'single' | 'compare';
  item?: LightboxItem;
  pair?: LightboxPair;
}): number {
  const frameRate =
    mode === 'compare' ? (pair?.after.frameRate ?? pair?.before.frameRate) : item?.frameRate;
  return typeof frameRate === 'number' && Number.isFinite(frameRate) && frameRate > 0
    ? frameRate
    : DEFAULT_VIDEO_FRAME_RATE;
}

export function mediaLightboxFrameStepSeconds(frames: -1 | 1, frameRate: number): number {
  const safeFrameRate =
    Number.isFinite(frameRate) && frameRate > 0 ? frameRate : DEFAULT_VIDEO_FRAME_RATE;
  return frames / safeFrameRate;
}
