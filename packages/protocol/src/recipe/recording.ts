import {
  addFinding,
  createContext,
  finishResult,
  isNonEmptyString,
  isRecord,
  isRelativeArtifactPath,
  type RecipeValidationResult,
} from './common.js';

/** Optional recording data; a recipe runner need not implement video capture. */
export interface RecipeVideoTiming {
  /** Decoded presentation timestamps in milliseconds on the video's seek clock. */
  framesMs: number[];
  durationMs: number;
  /** Bounds for the runner-clock time corresponding to media time zero. */
  clock: { source: string; earliestZeroUnixMs: number; latestZeroUnixMs: number };
}

export interface RecipeRecordingMarker {
  /** Index disambiguates repeated visits to the same composed node. */
  traceIndex: number;
  nodeId: string;
  action: string;
  intent?: string;
  proves?: string[];
  ok: boolean;
  /** Unclipped bounds; an event outside recorded footage is not made visible. */
  startRangeMs: [number, number];
  endRangeMs: [number, number];
}

export interface RecipeRecordingTimelineDocument extends RecipeVideoTiming {
  version: 1;
  videoPath: string;
  videoDigest: string;
  /** Canonical digest of the trace entry array, excluding optional metadata. */
  traceDigest: string;
  markers: RecipeRecordingMarker[];
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const range = (v: unknown): v is [number, number] =>
  Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) && v[0] <= v[1];

export function validateRecipeRecordingTimelineDocument(value: unknown): RecipeValidationResult {
  const ctx = createContext();
  const issue = (path: string, message: string) =>
    addFinding(ctx, 'error', 'recording_timeline.invalid', path, message);
  if (!isRecord(value)) {
    issue('$', 'Recording timeline must be an object.');
    return finishResult(ctx);
  }
  if (value.version !== 1) issue('version', 'Recording timeline version must be 1.');
  if (!isNonEmptyString(value.videoPath) || !isRelativeArtifactPath(value.videoPath))
    issue('videoPath', 'Video path must stay within the artifact package.');
  for (const field of ['videoDigest', 'traceDigest'])
    if (typeof value[field] !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value[field]))
      issue(field, 'A SHA-256 digest is required.');
  if (!finite(value.durationMs) || value.durationMs <= 0)
    issue('durationMs', 'Positive media duration is required.');
  if (
    !isRecord(value.clock) ||
    !isNonEmptyString(value.clock.source) ||
    !range([value.clock.earliestZeroUnixMs, value.clock.latestZeroUnixMs])
  )
    issue('clock', 'Recording requires measured clock alignment bounds and their source.');
  if (!Array.isArray(value.framesMs) || !value.framesMs.length) {
    issue('framesMs', 'At least one measured frame timestamp is required.');
  } else {
    let previous = -1;
    for (const [index, timestamp] of value.framesMs.entries()) {
      if (
        !finite(timestamp) ||
        timestamp < 0 ||
        timestamp <= previous ||
        (finite(value.durationMs) && timestamp >= value.durationMs)
      )
        issue(
          `framesMs[${index}]`,
          'Frame timestamps must increase strictly within the media duration.',
        );
      previous = timestamp;
    }
  }
  if (!Array.isArray(value.markers)) issue('markers', 'Markers must be an array.');
  else {
    const seen = new Set<number>();
    for (const [index, marker] of value.markers.entries()) {
      if (
        !isRecord(marker) ||
        !Number.isInteger(marker.traceIndex) ||
        (marker.traceIndex as number) < 0 ||
        !isNonEmptyString(marker.nodeId) ||
        !isNonEmptyString(marker.action) ||
        typeof marker.ok !== 'boolean' ||
        !range(marker.startRangeMs) ||
        !range(marker.endRangeMs) ||
        marker.endRangeMs[0] < marker.startRangeMs[0] ||
        marker.endRangeMs[1] < marker.startRangeMs[1] ||
        (marker.intent !== undefined && typeof marker.intent !== 'string') ||
        (marker.proves !== undefined &&
          (!Array.isArray(marker.proves) || !marker.proves.every(isNonEmptyString)))
      ) {
        issue(
          `markers[${index}]`,
          'Marker must identify its trace entry and ordered action time bounds.',
        );
        continue;
      }
      if (seen.has(marker.traceIndex as number))
        issue(`markers[${index}].traceIndex`, 'Duplicate trace entry.');
      seen.add(marker.traceIndex as number);
    }
  }
  return finishResult(ctx);
}
