import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

import { type RecipeRecordingInterruption, recipeTraceEntries } from '@farmslot/protocol';

import type { RecipeRunCaptureInterruption, RecipeRunResult, TraceEntry } from '../core/types.js';
import { summarizeTraceCounts } from '../node/writers.js';

/** capture-helper (0.3.1+) exits with this status after finalizing a partial recording. */
export const CAPTURE_HELPER_STREAM_INTERRUPTED_EXIT = 3;

/** Typed failure code for a run whose recording stream stopped early; the partial video is kept. */
export const CAPTURE_INTERRUPTED = 'CAPTURE_INTERRUPTED';

/** How reports and verdicts name a run whose only failure is a capture interruption. */
export { CAPTURE_EVIDENCE_INCOMPLETE } from '@farmslot/protocol';

/** The trace entry a kept partial recording adds (captureInterruptedTraceEntry). */
export function isCaptureInterruptedEntry(entry: unknown): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { error_code?: unknown }).error_code === CAPTURE_INTERRUPTED
  );
}

/**
 * True when a run failed only because its recording was interrupted: an infra event that left
 * the evidence incomplete, not a product failure. Any other failed entry makes it a failure.
 */
export function onlyCaptureInterrupted(entries: readonly unknown[]): boolean {
  const failed = entries.filter(
    (entry) =>
      typeof entry === 'object' && entry !== null && (entry as { ok?: unknown }).ok === false,
  );
  return failed.length > 0 && failed.every(isCaptureInterruptedEntry);
}

/** A run's trace.json entries, in either shape; undefined when the file is unreadable or malformed. */
export function readRunTraceEntries(tracePath: string): unknown[] | undefined {
  try {
    return recipeTraceEntries(JSON.parse(readFileSync(tracePath, 'utf8')));
  } catch {
    // Callers treat an unreadable trace as "no evidence": classification falls back to failure.
    return undefined;
  }
}

/** The run's capture interruption when it is the run's only failure (see onlyCaptureInterrupted). */
export function loneCaptureInterruption(
  result: Pick<RecipeRunResult, 'tracePath' | 'captureInterruption'>,
): RecipeRunCaptureInterruption | undefined {
  if (!result.captureInterruption) return undefined;
  // An unreadable trace is not a lone interruption, so the run is classified as a failure.
  const entries = readRunTraceEntries(result.tracePath);
  return entries && onlyCaptureInterrupted(entries) ? result.captureInterruption : undefined;
}

/** capture-helper's terminal `stream_interrupted` stderr event. */
export interface CaptureHelperInterruptionEvent extends RecipeRecordingInterruption {
  recordingId?: string;
}

/** A stopped stream cannot supply fresh session frames while its encoder finalizes. */
export function captureHelperStreamStopped(
  event: Record<string, unknown>,
  interruption: CaptureHelperInterruptionEvent | undefined,
): boolean {
  return event.code === 'stream_stopped' || Boolean(interruption);
}

/** Zero frames is the provider sentinel for unavailable capture measurements. */
export function hasCaptureInterruptionMeasurements(
  interruption: RecipeRecordingInterruption,
): boolean {
  return interruption.frames > 0;
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
  const measured = hasCaptureInterruptionMeasurements(interruption)
    ? ` after ${interruption.frames} frames (${seconds} s)`
    : '';
  return {
    ...interruption,
    videoPath,
    message: `${CAPTURE_INTERRUPTED}: the recording stream stopped${measured}: ${interruption.cause}. The partial video is kept at ${videoPath}.`,
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
