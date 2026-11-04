import type { PoolConfig } from '@farmslot/protocol';
import type { PoolFileEntry } from '@farmslot/protocol/node/slot-by-repo';
import { resolveMachinePool } from '@farmslot/slot-config';

// Retain loader provenance without exposing file paths in the public pool DTO.
const sourceFiles = new WeakMap<PoolConfig, string>();

export function rememberPoolFile(pool: PoolConfig, file: string): void {
  sourceFiles.set(pool, file);
}

export function resolveMachinePoolConfig(
  pools: readonly PoolConfig[],
  machine: string,
): PoolConfig | null {
  const entries = pools
    .filter((pool) => pool.machine === machine)
    .map((pool) => ({ file: sourceFiles.get(pool) ?? '', pool }));
  return resolveMachinePool(entries, machine) ?? null;
}

export function resolveMachinePoolConfigs(pools: readonly PoolConfig[]): Map<string, PoolConfig> {
  const grouped = new Map<string, PoolFileEntry<PoolConfig>[]>();
  for (const pool of pools) {
    const entries = grouped.get(pool.machine) ?? [];
    entries.push({ file: sourceFiles.get(pool) ?? '', pool });
    grouped.set(pool.machine, entries);
  }
  const resolved = new Map<string, PoolConfig>();
  for (const [machine, entries] of grouped) {
    const pool = resolveMachinePool(entries, machine);
    if (pool) resolved.set(machine, pool);
  }
  return resolved;
}
