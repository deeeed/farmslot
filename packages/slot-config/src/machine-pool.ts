import path from 'node:path';

import type { PoolFileEntry } from '@farmslot/protocol/node/slot-by-repo';

export function machinePoolFileName(machine: string): string {
  return `${machine}.json`;
}

/** Machine settings belong to pool/<machine>.json; other pools contribute slots. */
export function resolveMachinePool<T extends { machine: string }>(
  entries: readonly PoolFileEntry<T>[],
  machine: string,
): T | undefined {
  const matches = entries.filter((entry) => entry.pool.machine === machine);
  const canonical = matches.filter(
    (entry) => path.basename(entry.file) === machinePoolFileName(machine),
  );
  if (canonical.length === 1) return canonical[0].pool;
  if (canonical.length === 0 && matches.length <= 1) return matches[0]?.pool;
  throw new Error(`Machine ${machine} has ambiguous pool settings; configure pool/${machine}.json`);
}
