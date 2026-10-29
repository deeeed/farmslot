import assert from 'node:assert/strict';
import test from 'node:test';

import type { PendingDecision } from '@farmslot/protocol';

import { installFakeGateway } from '../../testing/fake-gateway.js';

test('a connected stale inbox cannot send commands, refresh cannot replay them, and refusals propagate', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'inbox-command-epoch';
  const decision: PendingDecision = {
    id: 'decision',
    type: 'blocked_alert',
    title: 'Worker decision',
    description: '',
    slotId: null,
    context: {},
    createdAt: new Date().toISOString(),
    actions: [{ id: 'acknowledge', label: 'Acknowledge', style: 'primary' }],
  };
  let hold = false;
  let revision = 0;
  const stamp = (family: string) => ({
    epoch: fake.resourceEpoch,
    dependencies: [
      { key: { family, scope: 'farm' }, revision: family === 'decisions' ? revision : 0 },
    ],
  });
  fake.responseForRequest = ({ method }) => {
    if (method === 'decision.resolve') return undefined;
    if (method === 'decision.list')
      return hold
        ? undefined
        : { payload: { decisions: [decision] }, resourceState: stamp('decisions') };
    if (method === 'run.list')
      return { payload: { runs: [], totalCount: 0 }, resourceState: stamp('runs') };
    return { payload: {} };
  };
  const { gateway } = await import('../../gateway-client.js');
  const { initState, decisionsQuery } = await import('../../state.js');
  const { getResourceCache, disposeResourceCache } = await import('../../resource-cache.js');
  const { resolveInboxDecision } = await import('./decision-inbox-actions.js');
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
  const cache = getResourceCache()!;
  await cache.retry(decisionsQuery);
  assert.equal(cache.read(decisionsQuery).status, 'ready');
  const socket = fake.sockets.at(-1)!;
  const sends = () => socket.sent.filter(({ method }) => method === 'decision.resolve');
  const reads = () => socket.sent.filter(({ method }) => method === 'decision.list').length;
  // The change arrives after the list's 30 s reread floor, so it is read at once.
  const now = performance.now.bind(performance);
  t.mock.method(performance, 'now', () => now() + 30_000);
  hold = true;
  revision++;
  socket.event('resource.changed', {
    version: 1,
    epoch: fake.resourceEpoch,
    changes: [{ key: { family: 'decisions', scope: 'farm' }, revision, kind: 'updated' }],
  });
  await flush();
  assert.equal(gateway.connectionState, 'connected');
  assert.equal(cache.read(decisionsQuery).status, 'stale');
  await assert.rejects(
    resolveInboxDecision('decision', 'acknowledge'),
    /Wait for current decisions/,
  );
  assert.equal(sends().length, 0);
  for (const read of socket.sent.filter(({ method }) => method === 'decision.list'))
    socket.response(read.id, { decisions: [decision] }, stamp('decisions'));
  hold = false;
  await flush();
  assert.equal(cache.read(decisionsQuery).status, 'ready');
  assert.equal(sends().length, 0, 'A current read must not replay an earlier refused command');
  await assert.rejects(
    resolveInboxDecision('missing', 'acknowledge'),
    /Wait for current decisions/,
  );
  await assert.rejects(resolveInboxDecision('decision', 'removed-action'), /decision changed/);
  assert.equal(sends().length, 0);
  const refused = resolveInboxDecision('decision', 'acknowledge');
  await flush();
  assert.equal(sends().length, 1);
  socket.failure(sends()[0].id, { code: 'METHOD_ERROR', message: 'Backend refused the write' });
  await assert.rejects(refused, /Backend refused the write/);
  assert.equal(cache.read(decisionsQuery).data?.decisions[0]?.id, 'decision');
  const before = reads();
  const resolved = resolveInboxDecision('decision', 'acknowledge');
  await flush();
  socket.response(sends()[1].id, {});
  await resolved;
  await flush();
  assert.equal(reads(), before + 1, 'An answered decision rereads the inbox at once');
});
