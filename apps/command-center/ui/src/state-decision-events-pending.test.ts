import assert from 'node:assert/strict';
import test from 'node:test';

import { Events } from '@farmslot/protocol';

import { installFakeGateway } from './testing/fake-gateway.js';

test('a decision event during an inbox read that predates it reads the inbox again once that read settles', async (t) => {
  const fake = installFakeGateway(t);
  fake.resourceEpoch = 'decision-events-epoch';
  let held = false;
  let revision = 1;
  const stamp = (family: string, revision: number) => ({
    epoch: fake.resourceEpoch,
    dependencies: [{ key: { family, scope: 'farm' }, revision }],
  });
  fake.responseForRequest = ({ method }) => {
    if (method === 'decision.list')
      return held
        ? undefined
        : { payload: { decisions: [] }, resourceState: stamp('decisions', revision) };
    if (method === 'run.list')
      return { payload: { runs: [], totalCount: 0 }, resourceState: stamp('runs', 0) };
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
  const socket = fake.sockets.at(-1)!;
  const reads = () => socket.sent.filter(({ method }) => method === 'decision.list');
  held = true;
  void cache.retry(decisionsQuery);
  await flush();
  const inFlight = reads().at(-1)!;
  socket.event(Events.DECISION_NEW, { decisionId: 'decision' });
  socket.event(Events.RESOURCE_CHANGED, {
    version: 1,
    epoch: fake.resourceEpoch,
    changes: [{ key: { family: 'decisions', scope: 'farm' }, revision: 2, kind: 'updated' }],
  });
  await flush();
  const before = reads().length;
  held = false;
  revision = 2;
  socket.response(inFlight.id, { decisions: [] }, stamp('decisions', 1));
  await flush();
  assert.equal(reads().length, before + 1, 'The event reads the inbox after the older read');
  assert.equal(cache.read(decisionsQuery).status, 'ready');
});
