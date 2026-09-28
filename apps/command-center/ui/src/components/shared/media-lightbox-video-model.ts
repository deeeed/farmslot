import {
  digestRecipeDocument,
  type RecipeRecordingTimelineDocument,
  validateRecipeRecordingTimelineDocument,
} from '@farmslot/protocol';

import type { LightboxItem } from './media-lightbox-types.js';

/** Adjacent encoded frame; maxFps is a capture ceiling, not a frame index. */
export function adjacentVideoFrameMs(
  framesMs: readonly number[],
  timeMs: number,
  direction: -1 | 1,
): number | null {
  if (!framesMs.length || !Number.isFinite(timeMs)) return null;
  let low = 0;
  let high = framesMs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (framesMs[middle]! <= timeMs + 0.001) low = middle + 1;
    else high = middle;
  }
  const current = Math.max(0, low - 1);
  return framesMs[Math.max(0, Math.min(framesMs.length - 1, current + direction))]!;
}

export function displayedVideoFrameRangeMs(
  framesMs: readonly number[],
  durationMs: number,
  timeMs: number,
): [number, number] | null {
  if (!framesMs.length || timeMs < framesMs[0]! || timeMs >= durationMs) return null;
  let low = 0;
  let high = framesMs.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (framesMs[middle]! <= timeMs) low = middle + 1;
    else high = middle;
  }
  return [framesMs[low - 1]!, framesMs[low] ?? durationMs];
}

export async function loadVideoTimeline(
  item: LightboxItem,
  readJson: (url: string) => Promise<unknown>,
): Promise<RecipeRecordingTimelineDocument> {
  if (!item.timelinePath || !item.resolveArtifactUrl || !item.sha256)
    throw new Error(
      item.timelineUnavailableReason ?? 'No verified recording timeline is available.',
    );
  const value = await readJson(item.resolveArtifactUrl(item.timelinePath));
  const validation = validateRecipeRecordingTimelineDocument(value);
  if (validation.status !== 'valid') throw new Error('Recording timeline is invalid.');
  const timeline = value as RecipeRecordingTimelineDocument;
  const videoDigest = item.sha256.startsWith('sha256:') ? item.sha256 : `sha256:${item.sha256}`;
  if (timeline.videoDigest !== videoDigest)
    throw new Error('Recording timeline belongs to different video bytes.');
  if (item.path !== timeline.videoPath && !item.path.endsWith(`/${timeline.videoPath}`))
    throw new Error('Recording timeline names a different video path.');
  const root = item.path.slice(0, item.path.length - timeline.videoPath.length);
  const rawTrace = await readJson(item.resolveArtifactUrl(`${root}trace.json`));
  const trace = Array.isArray(rawTrace)
    ? rawTrace
    : (rawTrace as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(trace) || digestRecipeDocument(trace) !== timeline.traceDigest)
    throw new Error('Recording timeline belongs to a different execution trace.');
  for (const marker of timeline.markers) {
    const entry = trace[marker.traceIndex];
    if (
      !entry ||
      entry.nodeId !== marker.nodeId ||
      entry.action !== marker.action ||
      entry.ok !== marker.ok ||
      entry.intent !== marker.intent ||
      digestRecipeDocument(entry.proves ?? []) !== digestRecipeDocument(marker.proves ?? [])
    )
      throw new Error('Recording marker does not match its execution trace.');
    const { earliestZeroUnixMs: earliest, latestZeroUnixMs: latest } = timeline.clock;
    for (const [timestamp, bounds] of [
      [entry.startedAt, marker.startRangeMs],
      [entry.endedAt, marker.endRangeMs],
    ] as const) {
      const at = Date.parse(timestamp);
      if (
        !Number.isFinite(at) ||
        Math.abs(bounds[0] - (at - latest)) > 0.001 ||
        Math.abs(bounds[1] - (at - earliest)) > 0.001
      )
        throw new Error('Recording marker time does not match its execution trace.');
    }
  }
  return timeline;
}
