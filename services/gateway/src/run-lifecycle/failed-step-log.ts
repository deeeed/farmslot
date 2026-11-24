import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, stat } from 'node:fs/promises';
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
  const keep = async (log: string, related = false): Promise<string> => {
    const copy = path.join(
      dir,
      `${path.basename(log, '.log')}-${stamp}-${randomUUID().slice(0, 8)}.log`,
    );
    try {
      const { size } = await stat(log);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (size <= MAX_LOG_COPY_BYTES) await copyFile(log, copy, constants.COPYFILE_EXCL);
      else await copyTail(log, copy, size);
      return copy;
    } catch (error) {
      // A related log the phase never reached (a build log when preflight failed before the
      // build) has nothing to keep.
      if (related && error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return log;
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
      ? await Promise.all(logs.relatedLogs.map((log) => keep(log, true)))
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

/** A log is copied whole up to this size; past it (a long-running metro.log), only its end. */
const MAX_LOG_COPY_BYTES = 4 * 1024 * 1024;

async function copyTail(log: string, copy: string, size: number): Promise<void> {
  const source = await open(log, 'r');
  try {
    const buffer = Buffer.alloc(MAX_LOG_COPY_BYTES);
    const { bytesRead } = await source.read(buffer, 0, buffer.length, size - buffer.length);
    const target = await open(copy, 'wx', 0o600);
    try {
      await target.write(`[farmslot] the last ${bytesRead} of ${size} bytes of ${log}\n`);
      await target.write(buffer.subarray(0, bytesRead));
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}
