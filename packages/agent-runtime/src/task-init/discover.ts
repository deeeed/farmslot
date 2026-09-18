// Finding task directories in a checkout. `task init` writes them under the
// tasks root as `<flow>/<slug>-<stamp>` on the farm and
// `recipe-cook/<stamp>-<slug>` from the skill (docs/reference/
// task-directory-contract.md), so every reader that wants "the task in progress
// here" needs the same walk: the directory whose signal or checklist was written
// last. Symlinked entries are not followed; a task directory is a real directory.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  INTERACTIVE_CHECKLIST_MARKDOWN,
  TASK_PROGRESS_MARKDOWN,
  WORKER_SIGNAL_FILE,
} from '@farmslot/protocol';

/**
 * How deep under the tasks root a task directory may sit. Both documented
 * shapes are depth 2; one extra level covers a grouped flow. The walk stops at
 * a directory that qualifies, so a task's `artifacts/` (which mirrors task
 * files) is never mistaken for a task of its own.
 */
export const TASK_DIR_SEARCH_DEPTH = 3;

export interface DiscoveredTaskDir {
  dir: string;
  /** Latest modification of SIGNAL.json, or null when the task never signalled. */
  signalMtimeMs: number | null;
  /** Latest modification of CHECKLIST.md or TASK.md. */
  checklistMtimeMs: number | null;
}

function fileMtimeMs(file: string): number | null {
  const stat = statSync(file, { throwIfNoEntry: false });
  return stat?.isFile() ? stat.mtimeMs : null;
}

function newest(...values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

/** Every directory under `tasksRoot` that holds a signal or a checklist. */
export function discoverTaskDirs(tasksRoot: string): DiscoveredTaskDir[] {
  const found: DiscoveredTaskDir[] = [];
  if (!statSync(tasksRoot, { throwIfNoEntry: false })?.isDirectory()) return found;
  const visit = (dir: string, depth: number): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      const signalMtimeMs = fileMtimeMs(path.join(child, WORKER_SIGNAL_FILE));
      const checklistMtimeMs = newest(
        fileMtimeMs(path.join(child, INTERACTIVE_CHECKLIST_MARKDOWN)),
        fileMtimeMs(path.join(child, TASK_PROGRESS_MARKDOWN)),
      );
      if (signalMtimeMs !== null || checklistMtimeMs !== null) {
        found.push({ dir: child, signalMtimeMs, checklistMtimeMs });
      } else if (depth < TASK_DIR_SEARCH_DEPTH) {
        visit(child, depth + 1);
      }
    }
  };
  visit(tasksRoot, 1);
  return found;
}

/**
 * The task directory a reader lands on without naming one: the one written to
 * last, by signal or by checklist. A checklist counts because between
 * `task init` and the worker's first `mark start` the live task has no signal
 * yet, and a reader must not fall back to the previous, finished task then.
 * Equal times prefer the signalled task, then the lexically first path, so two
 * readers of one checkout never land on different tasks.
 */
export function latestTaskDir(tasksRoot: string): string | undefined {
  const ranked = discoverTaskDirs(tasksRoot)
    .map((entry) => ({ entry, at: newest(entry.signalMtimeMs, entry.checklistMtimeMs) as number }))
    .sort(
      (left, right) =>
        right.at - left.at ||
        Number(right.entry.signalMtimeMs !== null) - Number(left.entry.signalMtimeMs !== null) ||
        left.entry.dir.localeCompare(right.entry.dir),
    );
  return ranked[0]?.entry.dir;
}
