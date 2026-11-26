import path from 'node:path';

import type { Run } from '@farmslot/protocol';

import { runTaskDirectories } from './store.js';

/** Task directories a run's pins serve: its task files, its review workspace's and a park's. */
export function pinTaskDirs(run: Run): string[] {
  const dirs = runTaskDirectories(run).map((dir) => path.resolve(dir));
  if (run.reviewWorkspace?.taskPath) dirs.push(path.resolve(run.reviewWorkspace.taskPath));
  const recovery = run.park?.recoveryHandle;
  if (recovery?.version === 1 && recovery.taskDir) dirs.push(path.resolve(recovery.taskDir));
  return dirs;
}

/**
 * Which task directories keep their pins and which release them (ADR-039 Amendment 12), the
 * one rule the gateway's own pin root and every node's share. A held run keeps the pins of every
 * directory it reads; a parked run keeps its pins whatever its hold; a released run's directories
 * release their pins unless a kept run also reads them.
 */
export function taskPinRelease(
  held: readonly Run[],
  released: readonly Run[],
): { keptDirs: Set<string>; releasedDirs: Set<string> } {
  const keptDirs = new Set<string>();
  for (const run of held) for (const dir of pinTaskDirs(run)) keptDirs.add(dir);
  for (const run of released) if (run.park) for (const dir of pinTaskDirs(run)) keptDirs.add(dir);
  const releasedDirs = new Set<string>();
  for (const run of released)
    if (!run.park)
      for (const dir of pinTaskDirs(run)) if (!keptDirs.has(dir)) releasedDirs.add(dir);
  return { keptDirs, releasedDirs };
}
