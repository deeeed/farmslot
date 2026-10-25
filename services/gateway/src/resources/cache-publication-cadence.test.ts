import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGatewayResourceCache,
  RESOURCE_PUBLISH_INTERVAL_MS,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
  type ResourceConnectionReason,
  resourceQuery,
} from '@farmslot/protocol/client-cache';

import { GatewayResourceRevisions, readWithResourceState } from './revisions.js';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  t.mock.method(performance, 'now', () => Date.now());
  const revisions = new GatewayResourceRevisions();
  const key = { family: 'copilot', ownerId: 'gateway-copilot' } as const;
  const interval = RESOURCE_PUBLISH_INTERVAL_MS.copilot!;
  assert.equal(interval, 200);
  const query = resourceQuery<{ value: string }>('copilot.status');
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: {
      gatewayUrl: 'ws://cadence.invalid',
      principalId: 'cadence-reader',
      principalGeneration: 0,
    },
    authority: { roles: [{ role: 'admin', scope: { kind: 'global' } }], workspaceAccess: 'farm' },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      batchedContent: false,
      resourceChanges: {
        version: 1,
        epoch: revisions.epoch,
        observedReads: 1,
        versionLists: false,
      },
    },
  };
  const started: number[] = [];
  const pending: Array<(value: string) => void> = [];
  const connections = new Set<Parameters<ResourceCacheTransport['onConnectionChange']>[0]>();
  const transport: ResourceCacheTransport = {
    getConnection: () => connection,
    onConnectionChange(listener) {
      connections.add(listener);
      return () => connections.delete(listener);
    },
    onResourceChanged(listener) {
      revisions.setPublisher(listener);
      return () => revisions.setPublisher(() => undefined);
    },
    resynchronize: () => assert.fail('No epoch or transport substitution'),
    async request<T>(...[_method, _params, signal]: Parameters<ResourceCacheTransport['request']>) {
      started.push(Date.now());
      const result = await readWithResourceState(
        query.dependencies,
        () =>
          new Promise<{ value: string }>((resolve, reject) => {
            const abort = () => reject(new Error('Disposed test read'));
            signal.addEventListener('abort', abort, { once: true });
            pending.push((value) => {
              signal.removeEventListener('abort', abort);
              resolve({ value });
            });
          }),
        revisions,
      );
      return { data: result.payload as T, resourceState: result.resourceState };
    },
  };
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => undefined);
  await turn();
  assert.equal(pending.length, 1);
  pending.shift()!('initial');
  await turn();
  return {
    revisions,
    key,
    interval,
    query,
    cache,
    stop,
    started,
    pending,
    change(change: Partial<ResourceCacheConnection>, reason: ResourceConnectionReason) {
      Object.assign(connection, change);
      for (const listener of connections) listener(connection, reason);
    },
  };
}

test('a slow read follow-up and the next coalesced publication respect the family read interval', async (t) => {
  const { revisions, key, interval, started, pending, cache, stop } = await fixture(t);
  try {
    t.mock.timers.tick(200);
    revisions.advance(key);
    t.mock.timers.tick(200);
    await turn();
    assert.equal(started.at(-1), 1400);
    t.mock.timers.tick(100);
    revisions.advance(key);
    t.mock.timers.tick(200);
    await turn();
    t.mock.timers.tick(1);
    revisions.advance(key);
    t.mock.timers.tick(189);
    pending.shift()!('obsolete');
    await turn();
    assert.equal(started.at(-1), 1890);
    pending.shift()!('current before the next write');
    await turn();
    t.mock.timers.tick(1);
    revisions.advance(key);
    t.mock.timers.tick(10);
    await turn();
    assert.equal(
      started.length,
      3,
      'The next notification cannot start another read after only11ms',
    );
    t.mock.timers.tick(189);
    await turn();
    assert.equal(started.length, 4);
    assert.equal(started.at(-1), 2090);
    assert(started.slice(1).every((at, index) => at - started[index]! >= interval));
  } finally {
    stop();
    await cache.dispose();
    revisions.dispose();
  }
});

async function deferredRead(t: test.TestContext) {
  const f = await fixture(t);
  f.revisions.advance(f.key);
  t.mock.timers.tick(190);
  const retried = f.cache.retry(f.query);
  await turn();
  f.pending.shift()!('explicit retry before publication');
  await retried;
  t.mock.timers.tick(1);
  f.revisions.advance(f.key);
  t.mock.timers.tick(9);
  await turn();
  assert.equal(f.started.length, 2, 'The next automatic read must currently be deferred');
  assert.equal(f.cache.read(f.query).status, 'stale');
  return f;
}

for (const reason of ['unobserve', 'network', 'dispose'] as const) {
  test(`a deferred automatic read never runs after ${reason}`, async (t) => {
    const f = await deferredRead(t);
    try {
      if (reason === 'unobserve') f.stop();
      else if (reason === 'network') f.change({ connected: false }, 'network');
      else await f.cache.dispose();
      t.mock.timers.tick(500);
      await turn();
      assert.equal(f.started.length, 2);
    } finally {
      f.stop();
      await f.cache.dispose();
      f.revisions.dispose();
    }
  });
}

test('a new connection starts its current read without the retired connection delay', async (t) => {
  const f = await deferredRead(t);
  try {
    f.change({ connected: false }, 'network');
    await turn();
    f.change({ connected: true, id: 2 }, 'network');
    await turn();
    assert.equal(f.started.length, 3);
    assert.equal(f.started.at(-1), 1200);
    f.pending.shift()!('current connection');
    await turn();
    t.mock.timers.tick(500);
    await turn();
    assert.equal(f.started.length, 3, 'The old deferred callback cannot add another read');
  } finally {
    f.stop();
    await f.cache.dispose();
    f.revisions.dispose();
  }
});

test('an explicit read can run during the automatic delay without a later duplicate', async (t) => {
  const f = await deferredRead(t);
  try {
    const retried = f.cache.retry(f.query);
    await turn();
    assert.equal(f.started.length, 3);
    assert.equal(f.started.at(-1), 1200);
    f.pending.shift()!('explicit operator read');
    await retried;
    t.mock.timers.tick(500);
    await turn();
    assert.equal(f.started.length, 3);
  } finally {
    f.stop();
    await f.cache.dispose();
    f.revisions.dispose();
  }
});
