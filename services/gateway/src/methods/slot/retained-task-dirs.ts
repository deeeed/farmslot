import path from 'node:path';

import { isTerminalRunStatus, type Run } from '@farmslot/protocol';
import { runBundleRefs } from '@farmslot/run-bundle';

/** A finished run whose bundle retains its output no longer needs its task dir on the slot. */
export function runOutputRetained(run: Run): boolean {
  return (
    isTerminalRunStatus(run.status) && !run.output?.captureError && runBundleRefs(run).length > 0
  );
}

/**
 * Task dirs, relative to the task root, of this slot's finished runs whose bundles retain
 * their output. A run still in progress, one whose capture failed, and `exceptRunId` keep
 * theirs: a task dir is only removed once the bundle has it.
 */
export function retainedPriorTaskDirs(
  runs: readonly Run[],
  repo: string,
  taskDirName: string,
  exceptRunId?: string,
): string[] {
  const root = path.posix.join(repo, taskDirName);
  const dirs: string[] = [];
  for (const run of runs) {
    if (run.id === exceptRunId || !run.taskFile || !runOutputRetained(run)) continue;
    const rel = path.posix.relative(root, path.posix.dirname(run.taskFile));
    if (rel && !rel.startsWith('..') && !path.posix.isAbsolute(rel)) dirs.push(rel);
  }
  return [...new Set(dirs)];
}
