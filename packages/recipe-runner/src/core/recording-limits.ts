import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { DEFAULT_RECORDED_EVIDENCE_POLICY } from '@farmslot/protocol';

import type {
  ActiveVideoRecording,
  RecipeVideoRecordingOptions,
  VideoRecordingResult,
} from './types.js';

/** Own exactly one backend stop, retaining usable media when a configured limit ends capture early. */
export function boundRecording(
  active: ActiveVideoRecording,
  outputPath: string,
  policy: RecipeVideoRecordingOptions,
): ActiveVideoRecording {
  const duration = policy.maxDurationMs ?? DEFAULT_RECORDED_EVIDENCE_POLICY.maxDurationMs;
  const bytes = policy.maxBytes ?? DEFAULT_RECORDED_EVIDENCE_POLICY.maxBytes;
  let stopped: Promise<VideoRecordingResult> | undefined;
  let limitation: string | undefined;
  let checking = false;
  const stop = () => {
    if (stopped) return stopped;
    clearTimeout(deadline);
    clearInterval(poll);
    stopped = active.stop().then((result) => {
      if (!limitation || result.interruption) return result;
      return {
        ...result,
        interruption: {
          frames: result.segments.reduce(
            (count, segment) => count + (segment.timing?.framesMs.length ?? 0),
            0,
          ),
          mediaTimeMs: result.segments.at(-1)?.timing?.framesMs.at(-1) ?? 0,
          cause: limitation,
        },
      };
    });
    // Early stop completion is awaited by the engine's final stop; retain rejection until then.
    void stopped.catch((error) => {
      limitation ??= `Capture finalization failed: ${error instanceof Error ? error.message : String(error)}`;
    });
    return stopped;
  };
  const deadline = setTimeout(() => {
    limitation = `Recording duration limit reached (${duration} ms).`;
    void stop();
  }, duration);
  deadline.unref();
  const poll = setInterval(async () => {
    if (checking || stopped) return;
    checking = true;
    try {
      const directory = path.dirname(outputPath);
      const files = (await readdir(directory)).filter((file) => file.endsWith('.mp4'));
      const sizes = await Promise.all(
        files.map(async (file) => (await stat(path.join(directory, file))).size),
      );
      if (sizes.reduce((total, size) => total + size, 0) >= bytes) {
        limitation = `Recording byte limit reached (${bytes} bytes).`;
        void stop();
      }
    } catch (error) {
      limitation = `Recording budget could not be measured: ${error instanceof Error ? error.message : String(error)}`;
      void stop();
    } finally {
      checking = false;
    }
  }, 250);
  poll.unref();
  return {
    stop,
    ...(active.snapshot
      ? {
          snapshot: async (file: string) => {
            if (stopped) throw new Error(limitation ?? 'Recording is finalizing.');
            return active.snapshot!(file);
          },
        }
      : {}),
  };
}
