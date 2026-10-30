import assert from 'node:assert/strict';
import test from 'node:test';

import type { PendingDecision } from '@farmslot/protocol';

import { installFakeGateway } from '../../testing/fake-gateway.js';

test('an answer rereads a paced inbox first, refuses outdated replies, never replays, and propagates refusals', async (t) => {
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
  const decisionReads = () => socket.sent.filter(({ method }) => method === 'decision.list');
  const reads = () => decisionReads().length;
  const change = () => {
    revision++;
    socket.event('resource.changed', {
      version: 1,
      epoch: fake.resourceEpoch,
      changes: [{ key: { family: 'decisions', scope: 'farm' }, revision, kind: 'updated' }],
    });
  };
  // A run write within 30 s of the last read leaves the inbox stale until its paced reread.
  let before = reads();
  change();
  await flush();
  assert.equal(gateway.connectionState, 'connected');
  assert.equal(cache.read(decisionsQuery).status, 'stale');
  assert.equal(reads(), before, 'The change waits for the reread floor');
  // An answer reads the inbox first; replies that never cover the change refuse it.
  hold = true;
  const outdated = resolveInboxDecision('decision', 'acknowledge');
  for (let reply = 1; reply <= 3; reply++) {
    await flush();
    assert.equal(reads(), before + reply);
    socket.response(
      decisionReads().at(-1)!.id,
      { decisions: [decision] },
      {
        epoch: fake.resourceEpoch,
        dependencies: [{ key: { family: 'decisions', scope: 'farm' }, revision: revision - 1 }],
      },
    );
  }
  await assert.rejects(outdated, /Wait for current decisions/);
  assert.equal(sends().length, 0);
  hold = false;
  await cache.retry(decisionsQuery);
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
  await flush();
  change();
  await flush();
  assert.equal(cache.read(decisionsQuery).status, 'stale');
  before = reads();
  const resolved = resolveInboxDecision('decision', 'acknowledge');
  await flush();
  assert.equal(reads(), before + 1, 'A paced inbox is read before the answer');
  assert.equal(sends().length, 2, 'and the answer is sent once the read is current');
  socket.response(sends()[1].id, {});
  await resolved;
  await flush();
  assert.equal(reads(), before + 2, 'An answered decision rereads the inbox at once');
});
