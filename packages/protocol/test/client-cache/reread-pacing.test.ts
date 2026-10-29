import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import {
  createGatewayResourceCache,
  RESOURCE_REREAD_INTERVAL_MS,
  RESOURCE_RETRY_MAX_WAIT_MS,
  type ResourceCacheTransport,
  type ResourceQuery,
  resourceQuery,
  type ResourceReadResult,
} from '../../src/client-cache/index.js';
import type { ResourceChangedPayload } from '../../src/transport/events.js';

/** A gateway whose reads stay open until the test answers or fails them. */
function pacedGateway(t: TestContext, query: ResourceQuery) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  t.mock.method(performance, 'now', () => Date.now());
  let changed: ((payload: ResourceChangedPayload) => void) | undefined;
  let revision = 0;
  const pending: Array<{ answer: () => void; fail: (error: Error) => void }> = [];
  let reads = 0;
  const transport: ResourceCacheTransport = {
    getConnection: () => ({
      id: 1,
      connected: true,
      authMode: 'token',
      scope: { gatewayUrl: 'ws://pacing.test', principalId: 'operator', principalGeneration: 0 },
      authority: { workspaceAccess: 'farm', roles: [] },
      capabilities: {
        httpBearerAuth: true,
        voiceInstructionFormatting: false,
        resourceChanges: {
          version: 1,
          epoch: 'pacing-epoch',
          versionLists: false,
          observedReads: 1,
          workspaceReads: 1,
        },
      },
    }),
    onConnectionChange: () => () => {},
    onResourceChanged: (listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
    request<T>() {
      reads++;
      const sampled = revision;
      return new Promise<ResourceReadResult<T>>((resolve, reject) =>
        pending.push({
          answer: () =>
            resolve({
              data: {} as T,
              resourceState: {
                epoch: 'pacing-epoch',
                dependencies: query.dependencies.map((key) => ({ key, revision: sampled })),
              },
            }),
          fail: reject,
        }),
      );
    },
    resynchronize: () => assert.fail('The source epoch did not change'),
  };
  const cache = createGatewayResourceCache({ transport });
  return {
    cache,
    reads: () => reads,
    pending,
    change() {
      revision++;
      changed!({
        version: 1,
        epoch: 'pacing-epoch',
        changes: query.dependencies.map((key) => ({ key, revision, kind: 'updated' })),
      });
    },
    async flush() {
      for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

test('a farm-wide slot read changing all the time is reread once per interval', async (t) => {
  const query = resourceQuery('fleet.status', {});
  const gateway = pacedGateway(t, query);
  const stop = gateway.cache.observe(query, () => {});
  try {
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    t.mock.timers.tick(1000);
    gateway.change();
    gateway.pending.shift()!.answer();
    await gateway.flush();
    assert.equal(gateway.reads(), 1, 'A slot change right after a read waits for the interval');
    gateway.change();
    t.mock.timers.tick(RESOURCE_REREAD_INTERVAL_MS.slots! - 1001);
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    t.mock.timers.tick(1);
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'Changes during the interval leave one follow-up');
    gateway.pending.shift()!.answer();
    await gateway.flush();
    assert.equal(gateway.cache.read(query).status, 'ready');
  } finally {
    stop();
  }
});

test('a timed-out read is not sent again while the gateway may still be working on it', async (t) => {
  const query = resourceQuery('decision.list', {});
  const gateway = pacedGateway(t, query);
  const stop = gateway.cache.observe(query, () => {});
  const timeOut = async (ms: number) => {
    gateway.change();
    t.mock.timers.tick(ms);
    gateway.pending.shift()!.fail(new Error('Request decision.list timed out'));
    await gateway.flush();
  };
  try {
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    await timeOut(15_000);
    assert.equal(gateway.reads(), 1, 'A changed source does not reread at once after a timeout');
    t.mock.timers.tick(14_999);
    await gateway.flush();
    assert.equal(gateway.reads(), 1);
    t.mock.timers.tick(1);
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'The first retry waits as long as the failed read took');
    await timeOut(15_000);
    t.mock.timers.tick(29_999);
    await gateway.flush();
    assert.equal(gateway.reads(), 2, 'Each further failure doubles the wait');
    t.mock.timers.tick(1);
    await gateway.flush();
    assert.equal(gateway.reads(), 3);
    for (let read = 4; read <= 8; read++) {
      await timeOut(15_000);
      t.mock.timers.tick(RESOURCE_RETRY_MAX_WAIT_MS);
      await gateway.flush();
      assert.equal(gateway.reads(), read, 'The wait stops growing at its maximum');
    }
    gateway.pending.shift()!.answer();
    await gateway.flush();
    assert.equal(gateway.cache.read(query).status, 'ready');
    gateway.change();
    await gateway.flush();
    assert.equal(gateway.reads(), 9, 'An answer ends the wait');
    gateway.pending.shift()!.answer();
    await gateway.flush();
  } finally {
    stop();
  }
});
