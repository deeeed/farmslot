import { rm } from 'node:fs/promises';

import type { ActiveVideoRecording, RecipeLogger } from './types.js';

interface AbortedRunVideoRecording {
  recording: ActiveVideoRecording;
  outputPath: string;
}

function cleanupErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function cleanupAbortedRunVideoRecording(
  runRecording: AbortedRunVideoRecording,
  logger: RecipeLogger,
): Promise<void> {
  try {
    await runRecording.recording.stop();
  } catch (error) {
    // Preserve the original run error while still surfacing cleanup failure evidence.
    logger.error(`record.video cleanup failed after run abort: ${cleanupErrorMessage(error)}`);
  }
  try {
    await rm(runRecording.outputPath, { force: true });
  } catch (error) {
    // Preserve the original run error while still surfacing cleanup failure evidence.
    logger.error(
      `record.video cleanup could not remove partial video: ${cleanupErrorMessage(error)}`,
    );
  }
}
