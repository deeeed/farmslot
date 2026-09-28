import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  type RecipeVideoTiming,
  validateRecipeRecordingTimelineDocument,
} from '@farmslot/protocol';

import { digestFileWithinRoot } from '../core/path.js';
import type { VideoRecordingResult } from '../core/types.js';

/** Consume capture facts from the finalized native recording, not a launch-time estimate. */
export async function readCaptureHelperTiming(
  outputPath: string,
): Promise<Pick<VideoRecordingResult, 'timing' | 'timingUnavailableReason'>> {
  try {
    const root = await realpath(path.dirname(outputPath));
    const name = path.basename(outputPath);
    const sidecar = await realpath(`${outputPath}.timing.json`);
    if (path.dirname(sidecar) !== root)
      throw new Error('Capture timing sidecar escapes the recording directory.');
    const data = JSON.parse(await readFile(sidecar, 'utf8'));
    if (
      data.version !== 1 ||
      typeof data.recording_id !== 'string' ||
      !data.recording_id ||
      data.video_file !== name
    )
      throw new Error('Capture timing identity does not match the recording.');
    const digest = await digestFileWithinRoot(root, name);
    if (data.video_digest !== digest)
      throw new Error('Capture timing digest does not match finalized video bytes.');
    const timing: RecipeVideoTiming = {
      framesMs: data.frames_ms,
      durationMs: data.duration_ms,
      clock: {
        source: data.clock?.source,
        earliestZeroUnixMs: data.clock?.earliest_zero_unix_ms,
        latestZeroUnixMs: data.clock?.latest_zero_unix_ms,
      },
    };
    const validation = validateRecipeRecordingTimelineDocument({
      ...timing,
      version: 1,
      videoPath: name,
      videoDigest: digest,
      traceDigest: `sha256:${'0'.repeat(64)}`,
      markers: [],
    });
    if (validation.status !== 'valid')
      throw new Error('Capture timing contains invalid frame or clock data.');
    return { timing };
  } catch (error) {
    return { timingUnavailableReason: error instanceof Error ? error.message : String(error) };
  }
}
