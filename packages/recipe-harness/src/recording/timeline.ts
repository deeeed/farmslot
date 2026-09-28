import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  digestRecipeDocument,
  type RecipeRecordingTimelineDocument,
  type RecipeVideoTiming,
  validateRecipeRecordingTimelineDocument,
} from '@farmslot/protocol';

import { digestFileWithinRoot, writeFileWithinRoot } from '../core/path.js';
import type { TraceEntry, VideoRecordingResult } from '../core/types.js';

const exec = promisify(execFile);

/** For continuous, real-time recordings: capture happened within these host
 * lifecycle bounds. This is deliberately a range, never a process-start guess. */
export async function probeVideoTiming(
  file: string,
  bounds:
    | { startedAtUnixMs: number; stoppedAtUnixMs: number }
    | { clock: RecipeVideoTiming['clock'] },
  ffprobePath = process.env.FFPROBE_PATH ?? 'ffprobe',
): Promise<RecipeVideoTiming> {
  const { stdout } = await exec(
    ffprobePath,
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_frames',
      '-show_entries',
      'frame=best_effort_timestamp_time,pkt_duration_time:format=duration',
      '-of',
      'json',
      file,
    ],
    { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
  );
  const probe = JSON.parse(stdout) as {
    frames?: { best_effort_timestamp_time?: string; pkt_duration_time?: string }[];
    format?: { duration?: string };
  };
  const framesMs = (probe.frames ?? []).map(
    (frame) => Number(frame.best_effort_timestamp_time) * 1000,
  );
  const first = framesMs[0];
  const last = framesMs.at(-1);
  if (
    first === undefined ||
    last === undefined ||
    framesMs.some(
      (time, i) => !Number.isFinite(time) || time < 0 || (i > 0 && time <= framesMs[i - 1]!),
    )
  )
    throw new Error('Video has no strictly ordered presentation timestamps.');
  const durationMs = Number(probe.format?.duration) * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= last)
    throw new Error('Video duration does not contain its measured frames.');
  const earliestZeroUnixMs =
    'clock' in bounds ? bounds.clock.earliestZeroUnixMs : bounds.startedAtUnixMs - first;
  const latestZeroUnixMs =
    'clock' in bounds ? bounds.clock.latestZeroUnixMs : bounds.stoppedAtUnixMs - last;
  if (
    !Number.isFinite(earliestZeroUnixMs) ||
    !Number.isFinite(latestZeroUnixMs) ||
    latestZeroUnixMs < earliestZeroUnixMs
  )
    throw new Error('Video timestamps do not fit the observed recorder lifetime.');
  return {
    framesMs,
    durationMs,
    clock: {
      source: 'clock' in bounds ? bounds.clock.source : 'recorder-lifetime-bound',
      earliestZeroUnixMs,
      latestZeroUnixMs,
    },
  };
}

/** Optional observability failure stays explicit without discarding a valid video. */
export async function optionalVideoTiming(
  ...args: Parameters<typeof probeVideoTiming>
): Promise<Pick<VideoRecordingResult, 'timing' | 'timingUnavailableReason'>> {
  try {
    return { timing: await probeVideoTiming(...args) };
  } catch (error) {
    return { timingUnavailableReason: error instanceof Error ? error.message : String(error) };
  }
}

export function createRecordingTimeline(
  videoPath: string,
  videoDigest: string,
  timing: RecipeVideoTiming,
  trace: TraceEntry[],
): RecipeRecordingTimelineDocument {
  const { earliestZeroUnixMs: earliest, latestZeroUnixMs: latest } = timing.clock;
  const document: RecipeRecordingTimelineDocument = {
    ...timing,
    version: 1,
    videoPath,
    videoDigest,
    traceDigest: digestRecipeDocument(trace),
    markers: trace.map((entry, traceIndex) => ({
      traceIndex,
      nodeId: entry.nodeId,
      action: entry.action,
      ok: entry.ok,
      ...(entry.intent ? { intent: entry.intent } : {}),
      ...(entry.proves ? { proves: entry.proves } : {}),
      startRangeMs: [Date.parse(entry.startedAt) - latest, Date.parse(entry.startedAt) - earliest],
      endRangeMs: [Date.parse(entry.endedAt) - latest, Date.parse(entry.endedAt) - earliest],
    })),
  };
  const result = validateRecipeRecordingTimelineDocument(document);
  if (result.status === 'invalid')
    throw new Error(`Invalid recording timeline: ${JSON.stringify(result.findings)}`);
  return document;
}

export async function writeRecordingTimeline(
  artifactsDir: string,
  videoPath: string,
  timing: RecipeVideoTiming,
  trace: TraceEntry[],
): Promise<string> {
  const videoDigest = await digestFileWithinRoot(artifactsDir, videoPath);
  const document = createRecordingTimeline(videoPath, videoDigest, timing, trace);
  const timelinePath = `${videoPath}.timeline.json`;
  await writeFileWithinRoot(artifactsDir, timelinePath, `${JSON.stringify(document)}\n`);
  return timelinePath;
}
