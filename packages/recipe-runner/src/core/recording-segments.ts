import { stat } from 'node:fs/promises';

import type {
  ActiveVideoRecording,
  VideoRecorder,
  VideoRecorderStartRequest,
  VideoRecordingResult,
  VideoRecordingSegment,
} from './types.js';

/** Backends with continuous segments handle their own boundaries; native restarts retain the gap. */
export async function startSegmentedRecording(
  recorder: VideoRecorder,
  request: VideoRecorderStartRequest,
): Promise<ActiveVideoRecording> {
  if (recorder.continuousSegments) return recorder.start(request);
  let active = await recorder.start(request);
  let output = request.outputPath;
  let startedAt = Date.now();
  let ended = false;
  let failure: unknown;
  let interruption: VideoRecordingResult['interruption'];
  const segments: VideoRecordingSegment[] = [];
  let boundary: Promise<void> | undefined;
  let stopped: Promise<VideoRecordingResult> | undefined;
  const collect = (result: VideoRecordingResult) => {
    for (const [index, segment] of result.segments.entries())
      segments.push({ ...segment, ...(segments.length && index === 0 ? { gapBefore: true } : {}) });
    interruption ??= result.interruption;
  };
  const rotate = async () => {
    collect(await active.stop());
    if (interruption) {
      ended = true;
      return;
    }
    output = request.outputPath.replace(/\.mp4$/u, `-segment-${segments.length}.mp4`);
    active = await recorder.start({ ...request, outputPath: output });
    startedAt = Date.now();
  };
  const poll = setInterval(() => {
    if (ended || boundary || failure) return;
    boundary = (async () => {
      let size = 0;
      try {
        size = (await stat(output)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (size >= 100 * 1024 * 1024 || Date.now() - startedAt >= 10 * 60 * 1000) await rotate();
    })()
      .catch((error) => {
        failure = error;
        ended = true;
      })
      .finally(() => {
        boundary = undefined;
      });
  }, 250);
  poll.unref();
  return {
    ...(active.snapshot
      ? {
          snapshot: async (file: string) => {
            if (ended || failure) throw failure ?? new Error('Recording has stopped.');
            if (boundary) await boundary;
            if (ended || failure) throw failure ?? new Error('Recording has stopped.');
            const result = await active.snapshot!(file);
            return { ...result, segmentIndex: segments.length };
          },
        }
      : {}),
    ...(active.ready
      ? {
          ready: async () => {
            if (boundary) await boundary;
            await active.ready?.();
          },
        }
      : {}),
    stop() {
      if (stopped) return stopped;
      clearInterval(poll);
      stopped = (async () => {
        if (boundary) await boundary;
        if (!ended) {
          ended = true;
          collect(await active.stop());
        }
        if (failure && !segments.length) throw failure;
        return {
          segments,
          ...(interruption
            ? { interruption }
            : failure
              ? {
                  interruption: {
                    frames: segments.reduce(
                      (count, segment) => count + (segment.timing?.framesMs.length ?? 0),
                      0,
                    ),
                    mediaTimeMs: segments.at(-1)?.timing?.framesMs.at(-1) ?? 0,
                    cause: failure instanceof Error ? failure.message : String(failure),
                  },
                }
              : {}),
        };
      })();
      return stopped;
    },
  };
}
