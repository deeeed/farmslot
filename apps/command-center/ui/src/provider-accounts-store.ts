/**
 * Shared client cache for per-machine runner-seat snapshots.
 *
 * The fleet map's Setup modal and the machine config page show the same data;
 * separate component caches meant opening one after the other re-queried and
 * re-rendered from empty. One store, one in-flight set: whichever surface
 * fetched first, the other renders instantly, and concurrent fetches for the
 * same machine collapse into one request. The gateway keeps its own 60s cache
 * underneath — `forceRefresh` punches through both to a live probe.
 */
import type {
  MachineProviderAccountsSnapshot,
  ProviderAccountsSnapshotResult,
} from '@farmslot/protocol';
import { Methods } from '@farmslot/protocol';

import { gateway } from './gateway-client.js';

type Listener = () => void;

const snapshots = new Map<string, MachineProviderAccountsSnapshot>();
const fetching = new Set<string>();
let lastError: string | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const providerAccountsStore = {
  get(machine: string): MachineProviderAccountsSnapshot | undefined {
    return snapshots.get(machine);
  },
  isFetching(machine: string): boolean {
    return fetching.has(machine);
  },
  error(): string | null {
    return lastError;
  },
  /** Subscribe to store changes; returns the unsubscribe function. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  async fetch(machines: string[], forceRefresh = false): Promise<void> {
    const want = machines.filter((m) => forceRefresh || !fetching.has(m));
    if (want.length === 0) return;
    for (const m of want) fetching.add(m);
    notify();
    try {
      // A forced refresh waits for live CLI probes (~20s/machine); cached
      // gateway responses answer in milliseconds.
      const res = await gateway.request<ProviderAccountsSnapshotResult>(
        Methods.PROVIDER_ACCOUNTS_SNAPSHOT,
        { machines: want, ...(forceRefresh ? { forceRefresh: true } : {}) },
        forceRefresh ? 45_000 : undefined,
      );
      for (const m of res.machines ?? []) snapshots.set(m.machine, m);
      lastError = null;
    } catch (err) {
      // Cached snapshots stay served; surfaces show the failure text.
      lastError = err instanceof Error ? err.message : String(err);
      console.warn('[provider-accounts-store] snapshot fetch failed:', lastError);
    } finally {
      for (const m of want) fetching.delete(m);
      notify();
    }
  },
};
