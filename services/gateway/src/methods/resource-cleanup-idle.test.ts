import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

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
  for (const slot of [
    'disabled-slot',
    'remote-disabled-slot',
    'bound-disabled-slot',
    'broken-disabled-slot',
    'manual-slot',
    'ready-slot',
  ])
    booted.add(slot);
  cache.clear();
  cache.set('ready-slot', 'running');
  cache.set('manual-slot', 'running');
  probed.length = 0;
  shutdowns.length = 0;
  // Probe on every read unless a test sets the TTL itself.
  process.env.FARMSLOT_DISABLED_SLOT_PROBE_TTL_MS = '0';
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
    slotProbeReachable: async (slotId: string) => {
      if (slotId === 'broken-disabled-slot')
        throw new Error("Slot 'broken-disabled-slot' has a relative repo on a remote host");
      return slotId !== 'remote-disabled-slot';
    },
  },
});

const fleetSlot = (
  slot: string,
  enabled: boolean,
  lifecycle: string,
  slotMachine = machine,
  currentRunId: string | null = null,
) => ({
  slot,
  machine: slotMachine,
  project: 'farmslot-farm',
  enabled,
  lifecycle,
  agent: enabled ? 'idle' : '-',
  currentRunId,
});

mock.module('../fleet/state.js', {
  namedExports: {
    getCachedFleet: () => null,
    loadFleetStatus: async () => ({
      slots: [
        fleetSlot('disabled-slot', false, 'disabled'),
        fleetSlot('remote-disabled-slot', false, 'disabled', remoteMachine),
        fleetSlot('bound-disabled-slot', false, 'disabled', machine, 'run-1'),
        fleetSlot('broken-disabled-slot', false, 'disabled'),
        fleetSlot('manual-slot', true, 'manual'),
        fleetSlot('ready-slot', true, 'ready'),
      ],
      machines: [],
    }),
  },
});

const { resourceCleanup } = await import('./resource.js');

const ttlBefore = process.env.FARMSLOT_DISABLED_SLOT_PROBE_TTL_MS;
after(() => {
  if (ttlBefore === undefined) delete process.env.FARMSLOT_DISABLED_SLOT_PROBE_TTL_MS;
  else process.env.FARMSLOT_DISABLED_SLOT_PROBE_TTL_MS = ttlBefore;
});

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
  // Not probed: the disconnected remote, a disabled slot still bound to a run, one
  // whose config fails locality (skipped, not fatal), and the enabled slots.
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

test('a disabled slot is probed again once its probed status is older than the TTL', async (t) => {
  reset();
  process.env.FARMSLOT_DISABLED_SLOT_PROBE_TTL_MS = '60000';
  // Past the earlier tests' probes, which ran on the real clock.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 120_000 });
  const offered = async () =>
    (await resourceCleanup({ dryRun: true, slotIds: ['disabled-slot'] })).targets.length === 1;

  assert.equal(await offered(), true);
  // Stopped outside the gateway: within the TTL the probed status is reused.
  booted.delete('disabled-slot');
  t.mock.timers.tick(30_000);
  assert.equal(await offered(), true);
  assert.deepEqual(probed, ['disabled-slot']);
  // After it, a fresh probe sees it stopped.
  t.mock.timers.tick(31_000);
  assert.equal(await offered(), false);
  // Booted again (a provisioning run): offered after the next TTL.
  booted.add('disabled-slot');
  t.mock.timers.tick(61_000);
  assert.equal(await offered(), true);
  assert.deepEqual(probed, ['disabled-slot', 'disabled-slot', 'disabled-slot']);
});
