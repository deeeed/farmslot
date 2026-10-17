import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { ResourceStatus } from '@farmslot/protocol';

const machine = 'test-machine';
const simulator = {
  id: 'ios-sim',
  definition: {
    type: 'device',
    platform: 'ios',
    label: 'iOS Sim',
    controllable: true,
    hooks: { health: 'probe', shutdown: 'stop' },
  },
  status: 'running' as ResourceStatus,
};
const shutdowns: string[] = [];

mock.module('../fleet/resource-manager.js', {
  namedExports: {
    executeResourceControl: async (slotId: string) => {
      shutdowns.push(slotId);
      return { ok: true };
    },
    getActiveResources: () => undefined,
    getCachedResourceStatus: () => 'running',
    getCachedSlotResources: () => undefined,
    getResourceWatchRuntimeState: () => ({ enabled: true, updatedAt: null }),
    // As the real poll does for a simulator on a slot without an active run:
    // the cache, unless the caller asks for a probe.
    pollSlotResources: async (_slotId: string, opts?: { probeInactiveSimulators?: boolean }) => [
      { id: 'ios-sim', status: opts?.probeInactiveSimulators ? 'stopped' : 'running' },
    ],
    resolveSlotResources: async () => [simulator],
    setResourceWatchesEnabled: async () => ({ enabled: true }),
  },
});

const idleSlot = (slot: string, enabled: boolean, lifecycle: string) => ({
  slot,
  machine,
  project: 'farmslot-farm',
  enabled,
  lifecycle,
  agent: 'idle',
  currentRunId: null,
});

mock.module('../fleet/state.js', {
  namedExports: {
    getCachedFleet: () => null,
    loadFleetStatus: async () => ({
      slots: [
        idleSlot('disabled-slot', false, 'disabled'),
        idleSlot('manual-slot', true, 'manual'),
        idleSlot('ready-slot', true, 'ready'),
      ],
      machines: [],
    }),
  },
});

const { resourceCleanup } = await import('./resource.js');

test('idle cleanup offers a disabled slot running resources but never a manual slot', async () => {
  const preview = await resourceCleanup({ dryRun: true });
  assert.deepEqual(
    preview.targets.map((target) => target.slotId),
    ['disabled-slot', 'ready-slot'],
  );
});

test('idle cleanup stops a disabled slot simulator and verifies it with a probe', async () => {
  shutdowns.length = 0;
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
