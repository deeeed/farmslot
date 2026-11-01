import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isRecord, type Run } from '@farmslot/protocol';

/**
 * The recipe libraries a bound task pinned at task init, by name: the copies in its task pin
 * that its binding names. A worker shell runs them instead of the shared checkouts they were
 * retained from, so a library rollout on the node cannot reach the run. Read from the gateway's
 * mirror of the task (`taskDir`); a task bound before pinning, or not bound, pins none.
 */
export function pinnedTaskLibraries(taskDir: string): Map<string, string> {
  const libraries = new Map<string, string>();
  const read = (file: string): unknown => {
    const full = path.join(taskDir, file);
    return existsSync(full) ? JSON.parse(readFileSync(full, 'utf8')) : undefined;
  };
  const receipt = read('artifacts/harness-provenance.json');
  const binding = read('inputs/recipe-binding.json');
  if (!isRecord(receipt) || typeof receipt.pin !== 'string' || !isRecord(binding)) return libraries;
  const pin = receipt.pin;
  const identity = binding.identity;
  if (!isRecord(identity) || !Array.isArray(identity.libraries)) return libraries;
  for (const library of identity.libraries) {
    if (
      isRecord(library) &&
      typeof library.name === 'string' &&
      typeof library.path === 'string' &&
      library.path.startsWith(`${pin}${path.posix.sep}`)
    )
      libraries.set(library.name, library.path);
  }
  return libraries;
}

/** A run's pinned recipe libraries, read from its mirrored task. */
export function runTaskLibraries(run: Pick<Run, 'taskFile'>): Map<string, string> | undefined {
  return run.taskFile ? pinnedTaskLibraries(path.dirname(run.taskFile)) : undefined;
}
