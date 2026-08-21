// pressure-read.ts — shared deduplicated reads over the Goal 1 pressure snapshot.
//
// Dispatch admission and machine parking both need per-machine pressure
// evidence, and both can be called in bursts (candidate scoring, preview →
// execute). One shared 1s TTL + in-flight coalescing layer keeps the expensive
// snapshot work (slot resource resolution, tmux worker attribution) at one
// execution per machine per second across all consumers, and the batch entry
// point folds a multi-machine request into a single snapshot call. This module
// adds no sampler and no polling — it only dedupes reads of the existing
// bounded snapshot/cache.

import type { ResourcePressureMachine } from '@farmslot/protocol';

import { resourcePressureSnapshot } from '../methods/resource.js';

import {
  cacheMachinePressureAttribution,
  resetPressureAttributionCacheForTest,
} from './pressure-attribution-cache.js';

const PRESSURE_READ_TTL_MS = 1_000;
const PRESSURE_READ_CACHE_LIMIT = 32;

interface PressureReadEntry {
  expiresAt: number;
  value?: ResourcePressureMachine;
  inFlight?: Promise<Map<string, ResourcePressureMachine>>;
}

const cache = new Map<string, PressureReadEntry>();

function evictOverflow(): void {
  while (cache.size > PRESSURE_READ_CACHE_LIMIT) {
    cache.delete(cache.keys().next().value!);
  }
}

async function snapshotMachines(machines: string[]): Promise<Map<string, ResourcePressureMachine>> {
  const snapshot = await resourcePressureSnapshot({ machines });
  for (const machine of snapshot.machines) {
    cacheMachinePressureAttribution(machine.machine, machine.processAttribution);
  }
  return new Map(snapshot.machines.map((machine) => [machine.machine, machine]));
}

/**
 * Read pressure evidence for a set of machines through one snapshot call.
 * Fresh cache hits and an in-flight read for the same machine are reused;
 * only the remaining machines pay for a snapshot, together, once.
 *
 * `fresh: true` bypasses settled cache entries (but still joins an identical
 * in-flight batch) — the dispatch mutation boundary uses it so execution
 * really recomputes current evidence. That costs one read per actual
 * dispatch, never per candidate row or poll.
 */
export async function readMachinesPressure(
  machines: string[],
  options?: { fresh?: boolean },
): Promise<Map<string, ResourcePressureMachine>> {
  const now = Date.now();
  const result = new Map<string, ResourcePressureMachine>();
  const pending: Array<[string, Promise<Map<string, ResourcePressureMachine>>]> = [];
  const missing: string[] = [];

  for (const machine of new Set(machines)) {
    const entry = cache.get(machine);
    if (entry?.inFlight) {
      pending.push([machine, entry.inFlight]);
    } else if (!options?.fresh && entry && entry.expiresAt > now) {
      if (entry.value) result.set(machine, structuredClone(entry.value));
    } else {
      missing.push(machine);
    }
  }

  if (missing.length > 0) {
    const inFlight = snapshotMachines(missing);
    for (const machine of missing) {
      cache.set(machine, { expiresAt: now + PRESSURE_READ_TTL_MS, inFlight });
      pending.push([machine, inFlight]);
    }
    evictOverflow();
    // A machine absent from the snapshot result (filtered out, unknown) caches
    // as a negative entry so a burst of callers does not re-run the snapshot.
    inFlight.then(
      (byMachine) => {
        for (const machine of missing) {
          cache.set(machine, {
            expiresAt: Date.now() + PRESSURE_READ_TTL_MS,
            value: byMachine.get(machine),
          });
        }
        evictOverflow();
      },
      () => {
        for (const machine of missing) {
          if (cache.get(machine)?.inFlight === inFlight) cache.delete(machine);
        }
      },
    );
  }

  for (const [machine, promise] of pending) {
    const byMachine = await promise;
    const value = byMachine.get(machine);
    if (value) result.set(machine, structuredClone(value));
  }
  return result;
}

/** Single-machine convenience over {@link readMachinesPressure}. */
export async function readMachinePressure(
  machine: string,
): Promise<ResourcePressureMachine | undefined> {
  return (await readMachinesPressure([machine])).get(machine);
}

/** Test hook: drop all cached/deduped reads. */
export function resetPressureReadCacheForTest(): void {
  cache.clear();
  resetPressureAttributionCacheForTest();
}
