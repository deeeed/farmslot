import assert from 'node:assert/strict';
import test from 'node:test';

import { Events } from '@farmslot/protocol';

import { installFakeGateway } from './testing/fake-gateway.js';

test('a decision raised, answered or changed rereads the inbox at once, inside the run write floor', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'decision-events-epoch';
  const stamp = (family: string) => ({
    epoch: fake.resourceEpoch,
    dependencies: [{ key: { family, scope: 'farm' }, revision: 0 }],
  });
  fake.responseForRequest = ({ method }) => {
    if (method === 'decision.list')
      return { payload: { decisions: [] }, resourceState: stamp('decisions') };
    if (method === 'run.list')
      return { payload: { runs: [], totalCount: 0 }, resourceState: stamp('runs') };
    return { payload: {} };
  };
  const { gateway } = await import('./gateway-client.js');
  const { initState, decisionsQuery } = await import('./state.js');
  const { getResourceCache, disposeResourceCache } = await import('./resource-cache.js');
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
  const reads = () => socket.sent.filter(({ method }) => method === 'decision.list').length;
  for (const event of [
    Events.DECISION_NEW,
    Events.DECISION_RESOLVED,
    Events.DECISION_UPDATED,
    Events.RUN_DECISION_NEW,
    Events.RUN_DECISION_RESOLVED,
    Events.RUN_DECISION_UPDATED,
  ]) {
    const before = reads();
    socket.event(event, { decisionId: 'decision' });
    await flush();
    assert.equal(reads(), before + 1, `${event} rereads the inbox`);
  }
});
