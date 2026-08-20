import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { SlotConfigError } from '../core/config.js';

const missingSlot = new SlotConfigError('SLOT_NOT_FOUND', "Slot 'stale-slot' not found");

mock.module('../fleet/resource-manager.js', {
  namedExports: {
    executeResourceControl: async () => ({ ok: true }),
    getActiveResources: () => undefined,
    getCachedResourceStatus: () => 'unknown',
    getResourceWatchRuntimeState: () => ({ enabled: true, updatedAt: null }),
    pollSlotResources: async () => [],
    resolveSlotResources: async () => {
      throw missingSlot;
    },
    setResourceWatchesEnabled: async () => ({ enabled: true }),
  },
});

mock.module('../fleet/state.js', {
  namedExports: {
    getCachedFleet: () => null,
    loadFleetStatus: async () => ({
      slots: [
        {
          slot: 'stale-slot',
          machine: 'test-machine',
          project: 'farmslot-farm',
          enabled: true,
          lifecycle: 'ready',
          agent: 'idle',
          currentRunId: null,
        },
      ],
      machines: [],
    }),
  },
});

const { resourceCleanup } = await import('./resource.js');

test('resourceCleanup dry-run skips a stale fleet slot that no longer resolves', async () => {
  assert.deepEqual(await resourceCleanup({ dryRun: true }), {
    ok: true,
    dryRun: true,
    targets: [],
    stopped: 0,
    failed: 0,
  });
});

test('resourceCleanup live execution still fails closed for an unresolvable slot', async () => {
  await assert.rejects(
    () =>
      resourceCleanup({
        dryRun: false,
        targets: [{ machine: 'test-machine', slotId: 'stale-slot', resourceId: 'metro' }],
      }),
    missingSlot,
  );
});

test('resourceCleanup live execution requires exact reviewed targets', async () => {
  await assert.rejects(() => resourceCleanup({ dryRun: false }), /requires exact reviewed targets/);
});
