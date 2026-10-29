import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReactiveControllerHost } from 'lit';

import type { RunListResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { installFakeGateway } from '../../testing/fake-gateway.js';

test('a run list waiting out its reread floor stays actable without a saved notice, and an action reads it first', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'paced-action-epoch';
  let revision = 0;
  const stamp = () => ({
    epoch: fake.resourceEpoch,
    dependencies: [{ key: { family: 'runs', scope: 'farm' }, revision }],
  });
  fake.responseForRequest = ({ method }) => {
    if (method === 'run.list')
      return { payload: { runs: [], totalCount: revision }, resourceState: stamp() };
    return { payload: {} };
  };
  const { gateway } = await import('../../gateway-client.js');
  const { initState } = await import('../../state.js');
  const { disposeResourceCache } = await import('../../resource-cache.js');
  const { canActOn, heldDataIsSaved, ResourceQueryController } =
    await import('./resource-query-controller.js');
  fake.beforeRestore = async () => {
    gateway.disconnect();
    await disposeResourceCache();
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  initState();
  await gateway.setAuthCredentials({ token: 'test-secret' });
  gateway.connect();
  await flush();
  const host: ReactiveControllerHost = {
    addController() {},
    removeController() {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  };
  const panel = new ResourceQueryController<RunListResult>(host);
  panel.setQuery(resourceQuery<RunListResult>('run.list', { tags: ['paced'] }));
  panel.hostConnected();
  await flush();
  assert.equal(panel.state.status, 'ready');
  const socket = fake.sockets.at(-1)!;
  const reads = () => socket.sent.filter(({ method }) => method === 'run.list').length;
  const before = reads();

  // A run write within 30 s of the last read waits for the floor.
  revision++;
  socket.event('resource.changed', {
    version: 1,
    epoch: fake.resourceEpoch,
    changes: [{ key: { family: 'runs', scope: 'farm' }, revision, kind: 'updated' }],
  });
  await flush();
  assert.equal(reads(), before, 'The change waits for the reread floor');
  assert.equal(panel.state.status, 'stale');
  assert.equal(heldDataIsSaved(panel.state), false, 'Waiting for a paced reread is not saved data');
  assert.equal(canActOn(panel.state), true);
  assert.equal(panel.actable, true);
  assert.equal(
    canActOn(panel.state, false),
    false,
    'Disconnected data is saved and never acted on',
  );
  assert.throws(() => panel.requireReady(), /Wait for a current read/);

  const current = await panel.requireCurrent();
  assert.equal(reads(), before + 1, 'An action reads the list at once');
  assert.equal(current.totalCount, revision);
  assert.equal(panel.state.status, 'ready');
  panel.hostDisconnected();
});
