// Finding task directories in a checkout. `task init` writes them under the
// tasks root as `<flow>/<slug>` (a dispatched run mirrors the same layout), so
// every reader that wants "the task in progress here" needs the same walk:
// the directory whose signal was written last, else the one whose checklist
// was touched last.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
  INTERACTIVE_CHECKLIST_MARKDOWN,
  TASK_PROGRESS_MARKDOWN,
  WORKER_SIGNAL_FILE,
} from '@farmslot/protocol';

/** How deep under the tasks root a task directory may sit (`<flow>/<slug>` is 2). */
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
      }
      if (depth < TASK_DIR_SEARCH_DEPTH) visit(child, depth + 1);
    }
  };
  visit(tasksRoot, 1);
  return found;
}

/**
 * The task directory a reader lands on without naming one: the most recently
 * signalled task, else the most recently touched checklist. A task that has
 * signalled always wins over one that only has a checklist, since a signal is
 * proof of an attempt.
 */
export function latestTaskDir(tasksRoot: string): string | undefined {
  const dirs = discoverTaskDirs(tasksRoot);
  const pick = (key: 'signalMtimeMs' | 'checklistMtimeMs'): DiscoveredTaskDir | undefined =>
    dirs
      .filter((entry) => entry[key] !== null)
      .sort((left, right) => (right[key] as number) - (left[key] as number))[0];
  return (pick('signalMtimeMs') ?? pick('checklistMtimeMs'))?.dir;
}
