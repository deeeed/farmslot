import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReactiveControllerHost } from 'lit';

import type { RunListResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { installFakeGateway } from '../../testing/fake-gateway.js';

test('reads that keep being superseded are named after the grace period, held or not', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'superseded-epoch';
  // run.list reads stay open until the test answers or refuses them.
  fake.responseForRequest = ({ method }) => (method === 'run.list' ? undefined : { payload: {} });
  const { gateway } = await import('../../gateway-client.js');
  const { initState } = await import('../../state.js');
  const { disposeResourceCache } = await import('../../resource-cache.js');
  const { heldDataIsSaved, readFailureText, readKeepsFailing, ResourceQueryController } =
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
  panel.setQuery(resourceQuery<RunListResult>('run.list'));
  panel.hostConnected();
  await flush();
  const socket = fake.sockets.at(-1)!;
  const lastRead = () => socket.sent.filter(({ method }) => method === 'run.list').at(-1)!;
  const superseded = {
    code: 'RESOURCE_OBSERVATION_CHANGED',
    message: 'The file observation changed during this read.',
  };

  // Nothing held: the read is refused because its source changed while it ran.
  socket.failure(lastRead().id, superseded);
  await flush();
  const since = panel.failingSince;
  assert.ok(since !== undefined);
  assert.equal(readFailureText(panel, since), undefined, 'a new superseded read is not named');
  // The reread clears a cold entry's error but not how long its reads have been failing.
  void panel.retry();
  await flush();
  assert.equal(panel.state.error, undefined);
  assert.equal(panel.failingSince, since);
  assert.equal(readKeepsFailing(panel, since + 59_999), false);
  assert.equal(readFailureText(panel, since + 60_000), 'not read yet');

  // An answer ends the streak.
  socket.response(
    lastRead().id,
    { runs: [], totalCount: 0 },
    {
      epoch: fake.resourceEpoch,
      dependencies: [{ key: { family: 'runs', scope: 'farm' }, revision: 0 }],
    },
  );
  await flush();
  assert.equal(panel.state.status, 'ready');
  assert.equal(panel.failingSince, undefined);

  // Held data: a superseded reread is not named, and the data counts as saved after the grace.
  void panel.retry();
  await flush();
  socket.failure(lastRead().id, superseded);
  await flush();
  const observedAt = panel.state.observedAt!;
  assert.equal(readFailureText(panel, observedAt), undefined);
  assert.equal(heldDataIsSaved(panel.state, true, observedAt + 59_999), false);
  assert.equal(heldDataIsSaved(panel.state, true, observedAt + 60_000), true);
  // Any other failure is named at once.
  void panel.retry();
  await flush();
  socket.failure(lastRead().id, { code: 'TIMEOUT', message: 'Request run.list timed out' });
  await flush();
  assert.equal(readFailureText(panel), 'Request run.list timed out');
  panel.hostDisconnected();
});
