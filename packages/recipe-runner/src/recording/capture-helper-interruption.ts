import type { RecipeRecordingInterruption } from '@farmslot/protocol';

/** capture-helper (0.3.1+) exits with this status after finalizing a partial recording. */
export const CAPTURE_HELPER_STREAM_INTERRUPTED_EXIT = 3;

/** Typed failure code for a run whose recording stream stopped early; the partial video is kept. */
export const CAPTURE_INTERRUPTED = 'CAPTURE_INTERRUPTED';

/** Read capture-helper's terminal `stream_interrupted` stderr event; undefined for any other event. */
export function parseCaptureHelperInterruption(
  event: Record<string, unknown>,
): (RecipeRecordingInterruption & { recordingId?: string }) | undefined {
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

export function captureInterruptedMessage(
  interruption: RecipeRecordingInterruption,
  videoPath: string,
): string {
  const seconds = (interruption.mediaTimeMs / 1000).toFixed(1);
  return `${CAPTURE_INTERRUPTED}: the recording stream stopped after ${interruption.frames} frames (${seconds} s): ${interruption.cause}. The partial video is kept at ${videoPath}.`;
}
