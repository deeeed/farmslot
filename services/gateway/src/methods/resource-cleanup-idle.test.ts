import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { ResourceStatus } from '@farmslot/protocol';

const machine = 'test-machine';
const remoteMachine = 'offline-machine';
const definition = {
  type: 'device',
  platform: 'ios',
  label: 'iOS Sim',
  controllable: true,
  hooks: { health: 'probe', shutdown: 'stop' },
};

// What a live gateway holds: node watches fill the cache for enabled slots only,
// so a disabled slot's simulator is unknown until something probes it.
const booted = new Set<string>();
const cache = new Map<string, ResourceStatus>();
const probed: string[] = [];
const shutdowns: string[] = [];
function reset() {
  for (const slot of ['disabled-slot', 'remote-disabled-slot', 'manual-slot', 'ready-slot'])
    booted.add(slot);
  cache.clear();
  cache.set('ready-slot', 'running');
  cache.set('manual-slot', 'running');
  probed.length = 0;
  shutdowns.length = 0;
}

mock.module('../fleet/resource-manager.js', {
  namedExports: {
    executeResourceControl: async (slotId: string) => {
      shutdowns.push(slotId);
      booted.delete(slotId);
      return { ok: true };
    },
    getActiveResources: () => undefined,
    getCachedResourceStatus: (slotId: string) => cache.get(slotId) ?? 'unknown',
    getCachedSlotResources: () => undefined,
    getResourceWatchRuntimeState: () => ({ enabled: true, updatedAt: null }),
    // As the real poll does for a simulator on a slot without an active run:
    // the cache, unless the caller asks for a probe, which also fills the cache.
    pollSlotResources: async (slotId: string, opts?: { probeInactiveSimulators?: boolean }) => {
      if (opts?.probeInactiveSimulators) {
        probed.push(slotId);
        cache.set(slotId, booted.has(slotId) ? 'running' : 'stopped');
      }
      return [{ id: 'ios-sim', status: cache.get(slotId) ?? 'unknown' }];
    },
    resolveSlotResources: async (slotId: string) => [
      { id: 'ios-sim', definition, status: cache.get(slotId) ?? 'unknown' },
    ],
    setResourceWatchesEnabled: async () => ({ enabled: true }),
    // The remote machine's node is not connected.
    slotProbeReachable: async (slotId: string) => slotId !== 'remote-disabled-slot',
  },
});

const fleetSlot = (slot: string, enabled: boolean, lifecycle: string, slotMachine = machine) => ({
  slot,
  machine: slotMachine,
  project: 'farmslot-farm',
  enabled,
  lifecycle,
  agent: enabled ? 'idle' : '-',
  currentRunId: null,
});

mock.module('../fleet/state.js', {
  namedExports: {
    getCachedFleet: () => null,
    loadFleetStatus: async () => ({
      slots: [
        fleetSlot('disabled-slot', false, 'disabled'),
        fleetSlot('remote-disabled-slot', false, 'disabled', remoteMachine),
        fleetSlot('manual-slot', true, 'manual'),
        fleetSlot('ready-slot', true, 'ready'),
      ],
      machines: [],
    }),
  },
});

const { resourceCleanup } = await import('./resource.js');

test('idle cleanup probes a disabled slot to offer what it left running, never a manual slot', async () => {
  reset();
  const preview = await resourceCleanup({ dryRun: true });
  assert.deepEqual(
    preview.targets.map((target) => [target.slotId, target.status]),
    [
      ['disabled-slot', 'running'],
      ['ready-slot', 'running'],
    ],
  );
  // The disconnected remote slot is not waited on; the enabled slots are not probed.
  assert.deepEqual(probed, ['disabled-slot']);
});

test('idle cleanup stops a disabled slot simulator and verifies it with a probe', async () => {
  reset();
  const result = await resourceCleanup({
    dryRun: false,
    targets: [
      { machine, slotId: 'disabled-slot', resourceId: 'ios-sim' },
      { machine, slotId: 'ready-slot', resourceId: 'ios-sim' },
    ],
  });
  assert.deepEqual(shutdowns, ['disabled-slot', 'ready-slot']);
  assert.deepEqual(
    result.targets.map(({ slotId, ok, afterStatus, detail }) => ({
      slotId,
      ok,
      afterStatus,
      detail,
    })),
    [
      { slotId: 'disabled-slot', ok: true, afterStatus: 'stopped', detail: undefined },
      { slotId: 'ready-slot', ok: true, afterStatus: 'stopped', detail: undefined },
    ],
  );
  assert.deepEqual([result.stopped, result.failed], [2, 0]);
});
