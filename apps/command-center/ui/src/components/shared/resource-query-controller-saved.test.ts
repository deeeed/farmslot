import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReactiveControllerHost } from 'lit';

import type { RunListResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { installFakeGateway } from '../../testing/fake-gateway.js';

test('a busy farm neither rereads a panel nor flashes its saved notice', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'saved-notice-epoch';
  let hold = false;
  let revision = 0;
  const stamp = () => ({
    epoch: fake.resourceEpoch,
    dependencies: [{ key: { family: 'runs', scope: 'farm' }, revision }],
  });
  fake.responseForRequest = ({ method }) => {
    if (method === 'run.list')
      return hold ? undefined : { payload: { runs: [], totalCount: 1 }, resourceState: stamp() };
    return { payload: {} };
  };
  const { gateway } = await import('../../gateway-client.js');
  const { initState } = await import('../../state.js');
  const { disposeResourceCache } = await import('../../resource-cache.js');
  const { heldDataIsSaved, ResourceQueryController } =
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
  const notices: boolean[] = [];
  const panel = new ResourceQueryController<RunListResult>(host, (state) =>
    notices.push(heldDataIsSaved(state)),
  );
  panel.setQuery(resourceQuery<RunListResult>('run.list'));
  panel.hostConnected();
  await flush();
  assert.equal(panel.state.status, 'ready');
  const socket = fake.sockets.at(-1)!;
  const reads = () => socket.sent.filter(({ method }) => method === 'run.list');
  const readsBefore = reads().length;
  notices.length = 0;

  // Other slots and workspaces change several times a second; this panel declares neither.
  for (let cycle = 1; cycle <= 5; cycle++) {
    socket.event('resource.changed', {
      version: 1,
      epoch: fake.resourceEpoch,
      changes: [
        { key: { family: 'slot', slotId: `other-${cycle}` }, revision: cycle, kind: 'updated' },
        {
          key: { family: 'workspace', slotId: `other-${cycle}` },
          revision: cycle,
          kind: 'updated',
        },
      ],
    });
    await flush();
  }
  assert.equal(reads().length, readsBefore, 'undeclared changes cause no reread');
  assert.equal(panel.state.status, 'ready');

  // A declared change rereads; the held data is stale only while that read runs.
  hold = true;
  revision++;
  socket.event('resource.changed', {
    version: 1,
    epoch: fake.resourceEpoch,
    changes: [{ key: { family: 'runs', scope: 'farm' }, revision, kind: 'updated' }],
  });
  await flush();
  assert.equal(panel.state.status, 'stale');
  assert.ok(notices.length > 0);
  assert.ok(
    notices.every((shown) => !shown),
    'no saved notice while a reread runs',
  );
  const reread = reads().at(-1)!;
  socket.failure(reread.id, { code: 'TIMEOUT', message: 'Request run.list timed out' });
  await flush();
  assert.equal(notices.at(-1), true, 'a failed read keeps the saved notice');
  panel.hostDisconnected();
});
