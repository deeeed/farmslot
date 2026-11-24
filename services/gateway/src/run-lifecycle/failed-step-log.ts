import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { runSessionArchiveDir } from '../runs/store.js';

/**
 * A failed step's log, kept for the run. Prepare's phase logs are named per slot
 * (`<phase>.log` under the slot's prepare log directory), so the next prepare on
 * that slot overwrites a failed run's evidence. The copy lives in the run's own
 * directory, which run retention removes with the run, and the step's message
 * names the copy instead of the slot log.
 */
export async function retainFailedStepLog(
  runId: string,
  logPath: string | undefined,
  message: string,
  now = new Date(),
): Promise<{ logPath: string | undefined; message: string }> {
  if (!logPath) return { logPath, message };
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const copy = path.join(
    runSessionArchiveDir(runId),
    'prepare-logs',
    `${path.basename(logPath, '.log')}-${stamp}.log`,
  );
  try {
    await mkdir(path.dirname(copy), { recursive: true, mode: 0o700 });
    await copyFile(logPath, copy);
  } catch (error) {
    // The step still fails, naming the slot log; only the per-run copy is missing.
    console.warn(
      `[run-engine] run ${runId.slice(0, 8)}: could not keep a copy of ${logPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { logPath, message };
  }
  return { logPath: copy, message: message.split(logPath).join(copy) };
}
