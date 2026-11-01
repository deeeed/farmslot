import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { WebSocket } from 'ws';

import type { FleetStatus, PoolConfig } from '@farmslot/protocol';

import * as realFleetState from '../fleet/state.js';

function pool(machine: string): PoolConfig {
  return {
    machine,
    project: 'farm',
    platform: 'mac',
    os: 'darwin',
    host: `${machine}.local`,
    sshUser: 'example',
    slots: [],
  };
}

const emptyFleet: FleetStatus = {
  checkedAt: '2026-11-01T00:00:00.000Z',
  slots: [],
  summary: {
    total: 0,
    ready: 0,
    busy: 0,
    held: 0,
    manual: 0,
    disabled: 0,
    blocked: 0,
    warmCount: 0,
  },
};

mock.module('../fleet/state.js', {
  namedExports: {
    ...realFleetState,
    loadPoolConfigs: async () => [pool('observed-online'), pool('observed-offline')],
    loadFleetStatus: async () => emptyFleet,
  },
});

const { registerNode, unregisterByWs } = await import('../fleet/machine-registry.js');
const { acceptWorkerObservation } = await import('../resources/worker-observations.js');
const { resourceRevisions } = await import('../resources/revisions.js');
const { GatewayMethodError } = await import('../core/method-error.js');
const { tmuxWorkerObservedList } = await import('./tmux-workers.js');

test('one pool node without a node connection does not empty the all-nodes worker list', async (t) => {
  const ws = { readyState: 1 } as WebSocket;
  t.after(() => {
    unregisterByWs(ws);
    resourceRevisions.dispose();
    resourceRevisions.setPublisher(() => {});
  });
  resourceRevisions.setPublisher(() => {});
  registerNode(
    'observed-online',
    1,
    ws,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    false,
    { workers: 1 },
    () => true,
  );
  acceptWorkerObservation(ws, {
    status: 'ready',
    observedAt: 1,
    panes: [{ session: 'work', window: '1', pane: '1', paneId: '%5', target: '%5' }],
  });

  const list = await tmuxWorkerObservedList();
  const online = list.nodes.find((node) => node.nodeId === 'observed-online');
  const offline = list.nodes.find((node) => node.nodeId === 'observed-offline');
  assert.equal(online?.ok, true);
  assert.deepEqual(
    list.workers.map((worker) => worker.ref.target),
    ['%5'],
  );
  assert.equal(offline?.ok, false);
  assert.equal(offline?.connected, false);
  assert.equal(offline?.error, 'Node observed-offline is disconnected');

  // A machine the caller names stays strict: no empty answer stands in for it.
  await assert.rejects(
    tmuxWorkerObservedList({ machine: 'observed-offline' }),
    (error) => error instanceof GatewayMethodError && error.code === 'RESOURCE_SOURCE_UNAVAILABLE',
  );
});
