import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReactiveControllerHost } from 'lit';

import type { RunListResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { installFakeGateway } from '../../testing/fake-gateway.js';

test('panel observers share reads, refuse stale actions and drop old filters and owners', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'panel-query-epoch';
  let hold = false;
  let revision = 0;
  const stamp = () => ({
    epoch: fake.resourceEpoch,
    dependencies: [{ key: { family: 'runs', scope: 'farm' }, revision }],
  });
  fake.responseForRequest = ({ method, params }) => {
    if (method === 'run.list') {
      if (hold) return undefined;
      const family =
        params && typeof params === 'object' ? Reflect.get(params, 'familyId') : undefined;
      return {
        payload: { runs: [], totalCount: family === 'new-filter' ? 2 : 1 },
        resourceState: stamp(),
      };
    }
    if (method === 'decision.list')
      return {
        payload: { decisions: [] },
        resourceState: {
          epoch: fake.resourceEpoch,
          dependencies: [{ key: { family: 'decisions', scope: 'farm' }, revision: 0 }],
        },
      };
    return { payload: {} };
  };
  const { gateway } = await import('../../gateway-client.js');
  const { initState } = await import('../../state.js');
  const { disposeResourceCache } = await import('../../resource-cache.js');
  const { notificationTray } = await import('../../utils/notification-tray.js');
  const { ResourceQueryController } = await import('./resource-query-controller.js');
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
  const first = new ResourceQueryController<RunListResult>(host);
  const second = new ResourceQueryController<RunListResult>(host);
  const query = resourceQuery<RunListResult>('run.list', { familyId: 'old-filter' });
  const socket = fake.sockets.at(-1)!;
  const readsBefore = socket.sent.length;
  first.setQuery(query);
  second.setQuery(query);
  first.hostConnected();
  second.hostConnected();
  await flush();
  assert.equal(
    socket.sent.slice(readsBefore).filter(({ method }) => method === 'run.list').length,
    1,
  );
  assert.equal(first.requireReady().totalCount, 1);
  assert.equal(second.state, first.state);
  first.hostDisconnected();
  second.hostDisconnected();
  const oneShot = new ResourceQueryController<RunListResult>(host, (state) => {
    if (state.status === 'ready') oneShot.setQuery(undefined);
  });
  oneShot.setQuery(query);
  oneShot.hostConnected();
  assert.equal(oneShot.ready, false);
  const filterReads = () =>
    fake.requests.filter(
      ({ method, params }) =>
        method === 'run.list' &&
        params &&
        typeof params === 'object' &&
        Reflect.get(params, 'familyId') === 'old-filter',
    ).length;
  const retiredReads = filterReads();
  revision++;
  socket.event('resource.changed', {
    version: 1,
    epoch: fake.resourceEpoch,
    changes: [{ key: { family: 'runs', scope: 'farm' }, revision, kind: 'updated' }],
  });
  await flush();
  assert.equal(
    filterReads(),
    retiredReads,
    'A query retired by an immediate reply must not retain interest',
  );
  oneShot.hostDisconnected();
  first.hostConnected();
  second.hostConnected();
  await flush();
  hold = true;
  revision++;
  socket.event('resource.changed', {
    version: 1,
    epoch: fake.resourceEpoch,
    changes: [{ key: { family: 'runs', scope: 'farm' }, revision, kind: 'updated' }],
  });
  await flush();
  assert.equal(first.state.status, 'stale');
  assert.equal(
    notificationTray.items.filter((item) => item.id === `read:${query.id}`).length,
    1,
    'Mounted observers publish one actual query notice',
  );
  assert.throws(() => first.requireReady(), /current read/);
  const heldReads = socket.sent.slice(readsBefore).filter(({ method }) => method === 'run.list');
  hold = false;
  first.setQuery(resourceQuery('run.list', { familyId: 'new-filter' }));
  await flush();
  assert.equal(first.requireReady().totalCount, 2);
  for (const request of heldReads)
    socket.response(request.id, { runs: [], totalCount: 1 }, stamp());
  await flush();
  assert.equal(
    first.requireReady().totalCount,
    2,
    'A previous filter cannot replace the current panel',
  );
  second.setQuery(undefined);
  assert.equal(
    notificationTray.items.some((item) => item.id === `read:${query.id}`),
    false,
    'Retiring the last observer removes its notice',
  );
  assert.equal(second.ready, false);
  assert.throws(() => second.requireReady(), /current read/);
  hold = true;
  await gateway.setAuthCredentials({ token: 'other-secret' });
  await flush();
  assert.equal(
    first.state.data,
    undefined,
    'A credential change removes the previous owner projection',
  );
  assert.throws(() => first.requireReady(), /current read/);
  first.hostDisconnected();
  second.hostDisconnected();
});
