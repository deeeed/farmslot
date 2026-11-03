import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { Methods, type ResourceListResult, type SlotStatus } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
} from '@farmslot/protocol/client-cache';

import { ResourceCacheConformanceTransport } from '../../../../../../packages/protocol/src/client-cache/conformance.js';
import { litText } from '../../testing/lit-text.js';

for (const child of [
  './machine-group.js',
  './machine-pause-dialog.js',
  './machine-pressure-overview.js',
  './resource-cleanup-preview.js',
  './resource-overview.js',
  '../slot-actions/slot-actions-modal.js',
  '../slot-actions/fleet-refresh-modal.js',
  '../shared/hydrating-placeholder.js',
])
  mock.module(child, { namedExports: {} });
mock.module('../../gateway-client.js', {
  namedExports: { gateway: { connectionState: 'connected' } },
});
let cache: ReturnType<typeof createGatewayResourceCache> | undefined;
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceCache: () => cache,
    getResourceWorkspaceKey: () => 'resource-owner',
    getResourceWorkspaceAccess: () => 'farm',
    subscribeResourceCache: () => () => undefined,
  },
});
mock.module('../../state.js', {
  namedExports: {
    fleetQuery: resourceQuery('fleet.status'),
    getState: () => ({}),
    getRunForSlot: () => undefined,
    isFleetCurrent: () => false,
    isHydrating: () => false,
    subscribe: () => () => undefined,
  },
});
const { FleetCanvas } = await import('./fleet-canvas.js');

test('resource groups from every stored slot render before the first four fresh replies', async () => {
  const scope = { gatewayUrl: 'ws://localhost:1234', principalId: 'owner', principalGeneration: 0 };
  const authority = { roles: [], workspaceAccess: 'farm' as const };
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority });
  const slots: SlotStatus[] = Array.from({ length: 6 }, (_, index) => ({
    slot: `held-${index}`,
    machine: 'mini',
    platform: 'browser',
    project: 'proof',
    health: { ssh: 'LOCAL', device: '-', devserver: '-', cdp: '-', fixtures: '-' },
    branch: 'main',
    agent: 'idle',
    enabled: true,
    dispatchable: true,
    lifecycle: 'ready',
    phase: null,
    warm: false,
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
  }));
  const data: ResourceListResult[] = slots.map((slot) => ({
    resources: [
      {
        id: slot.slot,
        status: 'running',
        definition: {
          type: 'browser',
          label: `Stored ${slot.slot}`,
          streamable: true,
          controllable: false,
        },
      },
    ],
  }));
  for (const [index, slot] of slots.entries()) {
    const query = resourceQuery(Methods.RESOURCE_LIST, { slotId: slot.slot });
    await store.putQuery({
      id: query.id,
      data: data[index],
      bytes: JSON.stringify(data[index]).length,
      observedAt: 123,
    });
  }
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  transport.connection.capabilities = {
    httpBearerAuth: true,
    voiceInstructionFormatting: false,
    batchedContent: false,
    resourceChanges: {
      version: 1,
      epoch: 'conformance-epoch',
      versionLists: false,
      observedReads: 1,
      workspaceReads: 1,
    },
  };
  transport.setConnection({ connected: true, id: 1 });
  cache = createGatewayResourceCache({ transport, store });
  const view = new FleetCanvas();
  Reflect.set(view, 'slots', slots);
  Reflect.set(view, 'fetchResourcePressure', async () => undefined);
  try {
    const finished = Reflect.get(view, 'fetchResourceData').call(view);
    const firstBatch = await Promise.all(Array.from({ length: 4 }, () => transport.nextRead()));
    assert.equal(transport.requestCount, 4, 'local hydration must preserve the network batch cap');
    const rendered = litText(Reflect.get(view, 'renderResourceView').call(view));
    assert.doesNotMatch(rendered, /Resource details loading/);
    assert.match(rendered, /Stored held-5/, 'a later batch already paints its saved group');
    for (const [index, pending] of firstBatch.entries()) pending.resolve(data[index]);
    const secondBatch = await Promise.all([transport.nextRead(), transport.nextRead()]);
    for (const [index, pending] of secondBatch.entries()) pending.resolve(data[index + 4]);
    await finished;
  } finally {
    await cache.dispose();
    cache = undefined;
  }
});
