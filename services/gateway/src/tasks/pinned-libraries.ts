import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { isRecord, type Run } from '@farmslot/protocol';

/**
 * The recipe libraries a bound task pinned at task init, by name: the copies in its task pin
 * that its binding names. A worker shell runs them instead of the shared checkouts they were
 * retained from, so a library rollout on the node cannot reach the run. Read from the receipt in
 * the gateway's mirror of the task (`taskDir`), whose binding identity task init verified; a task
 * bound before pinning, or not bound, pins none.
 */
export function pinnedTaskLibraries(taskDir: string): Map<string, string> {
  const libraries = new Map<string, string>();
  const file = path.join(taskDir, 'artifacts/harness-provenance.json');
  const receipt: unknown = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
  if (!isRecord(receipt) || typeof receipt.pin !== 'string') return libraries;
  const pin = receipt.pin;
  const identity = receipt.bindingIdentity;
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
