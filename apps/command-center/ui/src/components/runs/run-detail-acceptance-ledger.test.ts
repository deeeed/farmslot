import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReactiveControllerHost } from 'lit';

import type { TaskProgressResult } from '@farmslot/protocol';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { installFakeGateway } from '../../testing/fake-gateway.js';

test('the acceptance panel names no superseded ledger read for the grace period', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'ledger-epoch';
  // task.progress reads stay open until the test answers or refuses them.
  fake.responseForRequest = ({ method }) =>
    method === 'task.progress' ? undefined : { payload: {} };
  const { gateway } = await import('../../gateway-client.js');
  const { initState } = await import('../../state.js');
  const { disposeResourceCache } = await import('../../resource-cache.js');
  const { ResourceQueryController } = await import('../shared/resource-query-controller.js');
  const { acceptanceLedgerRead } = await import('./run-detail-model.js');
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
  const progress = new ResourceQueryController<TaskProgressResult>(host);
  progress.setQuery(
    resourceQuery<TaskProgressResult>('task.progress', { slotId: 'slot-1', runId: 'run-1' }),
  );
  progress.hostConnected();
  await flush();
  const socket = fake.sockets.at(-1)!;
  const lastRead = () => socket.sent.filter(({ method }) => method === 'task.progress').at(-1)!;
  const superseded = {
    code: 'RESOURCE_OBSERVATION_CHANGED',
    message: 'The file observation changed during this read.',
  };

  // A panel that does not belong to this workspace waits.
  assert.deepEqual(acceptanceLedgerRead(undefined), { error: null, pending: true });

  // Nothing held: the panel keeps waiting for the queued reread, and names it after the grace.
  socket.failure(lastRead().id, superseded);
  await flush();
  const since = progress.failingSince;
  assert.ok(since !== undefined);
  assert.deepEqual(acceptanceLedgerRead(progress, since), { error: null, pending: true });
  assert.deepEqual(acceptanceLedgerRead(progress, since + 59_999), {
    error: null,
    pending: true,
  });
  assert.deepEqual(acceptanceLedgerRead(progress, since + 60_000), {
    error: 'not read yet',
    pending: false,
  });

  // Held data: a superseded reread names nothing, and the ledger's own error still shows.
  void progress.retry();
  await flush();
  socket.response(
    lastRead().id,
    { slotId: 'slot-1', markdown: '', acceptanceStatusError: 'invalid acceptance-status.json' },
    {
      epoch: fake.resourceEpoch,
      dependencies: (['progress', 'run', 'artifacts'] as const).map((family) => ({
        key: { family, runId: 'run-1' },
        revision: 0,
      })),
    },
  );
  await flush();
  assert.equal(progress.state.status, 'ready');
  void progress.retry();
  await flush();
  socket.failure(lastRead().id, superseded);
  await flush();
  assert.equal(progress.state.status, 'stale');
  assert.deepEqual(acceptanceLedgerRead(progress), {
    error: 'invalid acceptance-status.json',
    pending: false,
  });

  // Any other failure is named at once.
  void progress.retry();
  await flush();
  socket.failure(lastRead().id, { code: 'TIMEOUT', message: 'Request task.progress timed out' });
  await flush();
  assert.deepEqual(acceptanceLedgerRead(progress), {
    error: 'Request task.progress timed out',
    pending: false,
  });
  progress.hostDisconnected();
});
