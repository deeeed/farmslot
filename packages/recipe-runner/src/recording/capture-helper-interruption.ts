import { readFile, writeFile } from 'node:fs/promises';

import { type RecipeRecordingInterruption, recipeTraceEntries } from '@farmslot/protocol';

import type { RecipeRunCaptureInterruption, RecipeRunResult, TraceEntry } from '../core/types.js';
import { summarizeTraceCounts } from '../node/writers.js';

/** capture-helper (0.3.1+) exits with this status after finalizing a partial recording. */
export const CAPTURE_HELPER_STREAM_INTERRUPTED_EXIT = 3;

/** Typed failure code for a run whose recording stream stopped early; the partial video is kept. */
export const CAPTURE_INTERRUPTED = 'CAPTURE_INTERRUPTED';

/** capture-helper's terminal `stream_interrupted` stderr event. */
export interface CaptureHelperInterruptionEvent extends RecipeRecordingInterruption {
  recordingId?: string;
}

/** Read capture-helper's terminal `stream_interrupted` stderr event; undefined for any other event. */
export function parseCaptureHelperInterruption(
  event: Record<string, unknown>,
): CaptureHelperInterruptionEvent | undefined {
  if (event.type !== 'error' || event.code !== 'stream_interrupted') return undefined;
  const { frames } = event;
  if (typeof frames !== 'number' || !Number.isInteger(frames) || frames <= 0) return undefined;
  return {
    frames,
    mediaTimeMs:
      typeof event.media_time_ms === 'number' && Number.isFinite(event.media_time_ms)
        ? event.media_time_ms
        : 0,
    cause: typeof event.cause === 'string' && event.cause ? event.cause : 'unknown cause',
    ...(typeof event.recording_id === 'string' && event.recording_id
      ? { recordingId: event.recording_id }
      : {}),
  };
}

/**
 * The interruption a recorder may keep footage for: capture-helper's partial-recording exit
 * together with its event. Either one alone is still a failed recording.
 */
export function keptCaptureInterruption(
  exitCode: number | null | undefined,
  event: CaptureHelperInterruptionEvent | undefined,
): RecipeRecordingInterruption | undefined {
  if (exitCode !== CAPTURE_HELPER_STREAM_INTERRUPTED_EXIT || !event) return undefined;
  return { frames: event.frames, mediaTimeMs: event.mediaTimeMs, cause: event.cause };
}

export function runCaptureInterruption(
  interruption: RecipeRecordingInterruption,
  videoPath: string,
): RecipeRunCaptureInterruption {
  const seconds = (interruption.mediaTimeMs / 1000).toFixed(1);
  return {
    ...interruption,
    videoPath,
    message: `${CAPTURE_INTERRUPTED}: the recording stream stopped after ${interruption.frames} frames (${seconds} s): ${interruption.cause}. The partial video is kept at ${videoPath}.`,
  };
}

/** The failed `recipe-run:video` trace entry a kept partial video adds to its run. */
export function captureInterruptedTraceEntry(
  run: RecipeRunCaptureInterruption,
  startedAt: Date,
): TraceEntry {
  const endedAt = new Date();
  return {
    nodeId: 'recipe-run:video',
    action: 'record.video',
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    ok: false,
    cause_class: 'environment',
    error: run.message,
    error_code: CAPTURE_INTERRUPTED,
    error_details: { frames: run.frames, mediaTimeMs: run.mediaTimeMs, cause: run.cause },
  };
}

/**
 * Add a capture interruption to a run package written before its recording stopped (a recorder
 * outside the runner): the trace entry, the summary status and counts, and the manifest status,
 * so the package fails the same way a runner-owned recording does.
 */
export async function recordCaptureInterruptionInPackage(
  result: Pick<RecipeRunResult, 'tracePath' | 'summaryPath' | 'artifactManifestPath'>,
  run: RecipeRunCaptureInterruption,
  startedAt: Date,
): Promise<void> {
  const trace: unknown = JSON.parse(await readFile(result.tracePath, 'utf8'));
  const entries = recipeTraceEntries(trace) as TraceEntry[] | undefined;
  if (!entries) throw new Error(`Run trace has no entries: ${result.tracePath}`);
  entries.push(captureInterruptedTraceEntry(run, startedAt));
  await writeJson(result.tracePath, trace);

  const summary = JSON.parse(await readFile(result.summaryPath, 'utf8'));
  await writeJson(result.summaryPath, {
    ...summary,
    status: 'fail',
    ...summarizeTraceCounts(entries),
  });

  const manifest = JSON.parse(await readFile(result.artifactManifestPath, 'utf8'));
  manifest.runStatus = 'fail';
  await writeJson(result.artifactManifestPath, manifest);
}

function writeJson(file: string, value: unknown): Promise<void> {
  return writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
