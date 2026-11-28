import { currentFarmPaths } from '@farmslot/protocol/node/farm-paths';
import type { PoolFileEntry } from '@farmslot/protocol/node/slot-by-repo';

import {
  type RawPoolJson,
  readSlotPools,
  resolveMachinePoolEntry,
  SlotConfigError,
  type SlotPools,
} from '../core/config.js';
import { isLocal } from '../core/locality.js';

type PoolEntry = PoolFileEntry<RawPoolJson>;
type MachinePoolResolution =
  | { readonly ok: true; readonly pool: RawPoolJson }
  | { readonly ok: false; readonly error: unknown };

export interface MachinePoolSnapshot {
  readonly pools: SlotPools;
  readonly entriesByMachine: ReadonlyMap<string, SlotPools>;
  readonly resolvedByMachine: ReadonlyMap<string, MachinePoolResolution>;
  readonly localMachines: readonly string[];
  readonly firstSlotByMachine: ReadonlyMap<string, string>;
  readonly poolBySlot: ReadonlyMap<string, SlotPools>;
}

const indexed = new WeakMap<SlotPools, MachinePoolSnapshot>();
const noPools: SlotPools = Object.freeze([]);

export function indexMachinePoolSnapshot(pools: SlotPools): MachinePoolSnapshot {
  const cached = indexed.get(pools);
  if (cached) return cached;

  const inventories: PoolEntry[] = [];
  const entriesByMachine = new Map<string, PoolEntry[]>();
  const settingsByMachine = new Map<string, PoolEntry[]>();
  const poolBySlot = new Map<string, SlotPools>();
  for (const entry of pools) {
    const { machine, slots } = entry.pool;
    if (typeof machine !== 'string' || !machine) continue;
    const settings = settingsByMachine.get(machine);
    if (settings) settings.push(entry);
    else settingsByMachine.set(machine, [entry]);

    if (
      slots &&
      (!Array.isArray(slots) ||
        slots.some((slot) => !slot || typeof slot !== 'object' || Array.isArray(slot)))
    ) {
      console.error(`[state] pool ${entry.file}: skipped invalid slot inventory`);
      continue;
    }
    inventories.push(entry);
    if (Array.isArray(slots))
      for (const slot of slots)
        if (slot.id && !poolBySlot.has(slot.id)) poolBySlot.set(slot.id, [entry]);
    const entries = entriesByMachine.get(machine);
    if (entries) entries.push(entry);
    else entriesByMachine.set(machine, [entry]);
  }

  const resolvedByMachine = new Map<string, MachinePoolResolution>();
  const localMachines: string[] = [];
  const firstSlotByMachine = new Map<string, string>();
  for (const [machine, entries] of settingsByMachine) {
    let canonical: PoolEntry | undefined;
    try {
      canonical = resolveMachinePoolEntry(entries, machine);
      if (canonical) {
        resolvedByMachine.set(machine, { ok: true, pool: canonical.pool });
        if (isLocal(canonical.pool.host, machine)) localMachines.push(machine);
      }
    } catch (error) {
      // An ambiguous local machine must still participate in local resolution so it fails closed.
      resolvedByMachine.set(machine, { ok: false, error });
      if (entries.some(({ pool }) => isLocal(pool.host, machine))) localMachines.push(machine);
    }

    // Machine settings and slot inventory have different ownership. Auxiliary slots remain usable
    // even if the canonical pool declares none, or the machine has only auxiliary pools.
    const inventory = entriesByMachine.get(machine) ?? [];
    const canonicalSlot =
      canonical && inventory.includes(canonical) ? canonical.pool.slots?.[0]?.id : undefined;
    const firstSlot =
      canonicalSlot ?? inventory.find(({ pool }) => pool.slots?.[0]?.id)?.pool.slots[0]?.id;
    if (firstSlot) firstSlotByMachine.set(machine, firstSlot);
  }

  const snapshot = {
    pools: inventories,
    entriesByMachine,
    resolvedByMachine,
    localMachines,
    firstSlotByMachine,
    poolBySlot,
  };
  indexed.set(pools, snapshot);
  return snapshot;
}

interface WatchedPool {
  directory: string;
  snapshot?: MachinePoolSnapshot;
  demoPool?: string;
}
let watchedPool: WatchedPool | undefined;

/** Called once the existing gateway pool watcher is ready to deliver invalidations. */
export function observeMachinePoolSnapshot(directory: string): () => void {
  const owner: WatchedPool = { directory };
  watchedPool = owner;
  return () => {
    if (watchedPool === owner) watchedPool = undefined;
  };
}

export function invalidateMachinePoolSnapshot(directory: string): void {
  if (watchedPool?.directory === directory) watchedPool.snapshot = undefined;
}

export function readMachinePoolSnapshot(): MachinePoolSnapshot {
  const directory = currentFarmPaths('gateway').pool;
  const owner = watchedPool?.directory === directory ? watchedPool : undefined;
  const demoPool = process.env.FARMSLOT_DEMO_POOL;
  if (owner?.snapshot && owner.demoPool === demoPool) return owner.snapshot;
  let pools: SlotPools;
  try {
    pools = readSlotPools();
  } catch (error) {
    // Missing directories may be created later, even when the watcher has no entry to invalidate.
    if (error instanceof SlotConfigError && error.code === 'POOL_DIR_NOT_FOUND')
      return indexMachinePoolSnapshot(noPools);
    throw error;
  }
  const snapshot = indexMachinePoolSnapshot(pools);
  if (owner) {
    owner.snapshot = snapshot;
    owner.demoPool = demoPool;
  }
  return snapshot;
}
