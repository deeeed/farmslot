import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { runSessionArchiveDir } from '../runs/store.js';

/** The logs a failed step names; related logs are slot-host paths, local only for a local slot. */
export interface FailedStepLogs {
  failedLogPath?: string;
  relatedLogs?: string[];
  relatedLogsOnGateway?: boolean;
}

/**
 * A failed step's logs, kept for the run. Prepare's phase logs are named per slot
 * (`<phase>.log` under the slot's prepare log directory), so the next prepare on
 * that slot overwrites a failed run's evidence. The copies live in the run's own
 * directory, which run retention removes with the run, and the step's message
 * names the copy of the failed log instead of the slot log. A log that cannot be
 * copied keeps its slot path.
 */
export async function retainFailedStepLogs(
  runId: string,
  logs: FailedStepLogs,
  message: string,
  now = new Date(),
): Promise<{ failedLogPath?: string; relatedLogs?: string[]; message: string }> {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(runSessionArchiveDir(runId), 'prepare-logs');
  const keep = async (log: string): Promise<string> => {
    const copy = path.join(
      dir,
      `${path.basename(log, '.log')}-${stamp}-${randomUUID().slice(0, 8)}.log`,
    );
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await copyFile(log, copy, constants.COPYFILE_EXCL);
      return copy;
    } catch (error) {
      // The step still fails, naming the slot log; only the per-run copy is missing.
      console.warn(
        `[run-engine] run ${runId.slice(0, 8)}: could not keep a copy of ${log}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return log;
    }
  };
  const failedLogPath = logs.failedLogPath && (await keep(logs.failedLogPath));
  const relatedLogs =
    logs.relatedLogs && logs.relatedLogsOnGateway
      ? await Promise.all(logs.relatedLogs.map(keep))
      : logs.relatedLogs;
  if (!logs.failedLogPath || failedLogPath === logs.failedLogPath)
    return { failedLogPath: logs.failedLogPath, relatedLogs, message };
  return {
    failedLogPath,
    relatedLogs,
    message: message.includes(logs.failedLogPath)
      ? message.split(logs.failedLogPath).join(failedLogPath)
      : `${message} — log: ${failedLogPath}`,
  };
}
