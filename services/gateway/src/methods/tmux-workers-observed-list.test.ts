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

function connect(machine: string): WebSocket {
  const ws = { readyState: 1 } as WebSocket;
  registerNode(
    machine,
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
  return ws;
}

test('a node without a current observation does not empty the all-nodes worker list', async (t) => {
  resourceRevisions.setPublisher(() => {});
  const online = connect('observed-online');
  // Connected, but no observation published yet (the window after every node connect).
  const pending = connect('observed-pending');
  t.after(() => {
    unregisterByWs(online);
    unregisterByWs(pending);
    resourceRevisions.dispose();
    resourceRevisions.setPublisher(() => {});
  });
  acceptWorkerObservation(online, {
    status: 'ready',
    observedAt: 1,
    panes: [{ session: 'work', window: '1', pane: '1', paneId: '%5', target: '%5' }],
  });

  const list = await tmuxWorkerObservedList();
  const row = (nodeId: string) => {
    const node = list.nodes.find((entry) => entry.nodeId === nodeId);
    return node && { ok: node.ok, connected: node.connected, error: node.error };
  };
  assert.deepEqual(row('observed-online'), { ok: true, connected: true, error: undefined });
  assert.deepEqual(
    list.workers.map((worker) => worker.ref.target),
    ['%5'],
  );
  assert.deepEqual(row('observed-pending'), {
    ok: false,
    connected: true,
    error: 'Node observed-pending has not published worker observations',
  });
  assert.deepEqual(row('observed-offline'), {
    ok: false,
    connected: false,
    error: 'node observed-offline is not connected',
  });

  // includeDisconnected: false hides only the node with no connection.
  const connectedOnly = await tmuxWorkerObservedList({ includeDisconnected: false });
  assert.deepEqual(connectedOnly.nodes.map((node) => node.nodeId).sort(), [
    'observed-online',
    'observed-pending',
  ]);

  // A machine the caller names stays strict: no empty answer stands in for it.
  await assert.rejects(
    tmuxWorkerObservedList({ machine: 'observed-offline' }),
    (error) => error instanceof GatewayMethodError && error.code === 'RESOURCE_SOURCE_UNAVAILABLE',
  );
});
