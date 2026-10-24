import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
  type ResourceQueryState,
  type ResourceStore,
} from '../../src/client-cache/index.js';

const scope = { gatewayUrl: 'ws://persistent.invalid/', principalId: 'p', principalGeneration: 0 };
const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };

test('a failed offline reconnect cannot discard saved data whose hydration is still pending', async () => {
  const memory = createMemoryResourceStore();
  const authority = { roles: [], workspaceAccess: 'farm' as const };
  await memory.setMetadata({ scope, authority });
  await memory.putQuery({ id: query.id, data: { value: 'saved' }, observedAt: 123, bytes: 17 });
  let start!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: ResourceStore = {
    ...memory,
    get deleted() {
      return memory.deleted;
    },
    async getQuery<T>(id: string) {
      const saved = await memory.getQuery<T>(id);
      start();
      await held;
      return saved;
    },
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  const cache = createGatewayResourceCache({ transport, store });
  const stop = cache.observe(query, () => undefined);
  try {
    await started;
    transport.setConnection({ connected: false, id: 2 }, 'network');
    release();
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cache.read(query).status, 'stale');
    assert.equal(cache.read(query).data?.value, 'saved');
    assert.equal(cache.read(query).observedAt, 123);
    assert.equal(transport.requestCount, 0);
  } finally {
    release();
    stop();
    await cache.dispose();
  }
});

for (const transition of ['sign-out', 'principal', 'authority'] as const) {
  test(`pending hydration cannot restore data after ${transition} changes its owner`, async () => {
    const memory = createMemoryResourceStore();
    const authority = { roles: [], workspaceAccess: 'farm' as const };
    await memory.setMetadata({ scope, authority });
    await memory.putQuery({ id: query.id, data: { value: 'private' }, observedAt: 123, bytes: 19 });
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: ResourceStore = {
      ...memory,
      get deleted() {
        return memory.deleted;
      },
      async getQuery<T>(id: string) {
        const saved = await memory.getQuery<T>(id);
        start();
        await held;
        return saved;
      },
    };
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.connection.authority = authority;
    const cache = createGatewayResourceCache({ transport, store });
    let transitioned = false;
    let leaked = false;
    const stop = cache.observe(query, (state) => {
      if (transitioned && state.data) leaked = true;
    });
    try {
      await started;
      release();
      await Promise.resolve();
      transitioned = true;
      if (transition === 'sign-out') transport.setConnection({ connected: false }, 'sign-out');
      else if (transition === 'principal')
        transport.setConnection({ scope: { ...scope, principalId: 'another' } });
      else transport.setConnection({ authority: { roles: [], workspaceAccess: 'native' } });
      for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(leaked, false, 'A queued old hydration must never publish after revocation');
      assert.equal(cache.read(query).data, undefined);
    } finally {
      release();
      stop();
      await cache.dispose();
    }
  });
}

test('a late remembered offline identity opens and hydrates its stored result without network reads', async () => {
  const saved = createMemoryResourceStore();
  const authority = { roles: [], workspaceAccess: 'farm' as const };
  await saved.setMetadata({ scope, authority });
  await saved.putQuery({ id: query.id, data: { value: 'offline' }, observedAt: 123, bytes: 19 });
  const transport = new ResourceCacheConformanceTransport({ gatewayUrl: scope.gatewayUrl });
  transport.connection.authority = undefined;
  const cache = createGatewayResourceCache({ transport, openStore: async () => saved });
  let resolve!: (state: ResourceQueryState<{ value: string }>) => void;
  const hydrated = new Promise<ResourceQueryState<{ value: string }>>((done) => {
    resolve = done;
  });
  const stop = cache.observe(query, (state) => {
    if (state.data) resolve(state);
  });
  try {
    await new Promise<void>((done) => setImmediate(done));
    transport.setConnection({ scope, authority });
    const state = await Promise.race([
      hydrated,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Stored offline query did not hydrate')),
          500,
        );
        hydrated.finally(() => clearTimeout(timer));
      }),
    ]);
    assert.equal(state.status, 'stale');
    assert.equal(state.observedAt, 123);
    assert.equal(transport.requestCount, 0);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('a factory opening an existing store checks its recorded authority before any reply applies', async () => {
  const old = createMemoryResourceStore();
  await old.setMetadata({ scope, authority: { roles: [], workspaceAccess: 'farm' } });
  await old.putQuery({
    id: query.id,
    data: { value: 'former authority' },
    observedAt: 1,
    bytes: 28,
  });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  let opens = 0;
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => (++opens === 1 ? old : createMemoryResourceStore()),
  });
  try {
    const done = cache.retry(query);
    const read = await transport.nextRead();
    assert(
      old.deleted,
      'factory-opened data must obey the same authority guard as a supplied store',
    );
    assert.equal(cache.read(query).data, undefined);
    read.resolve({ value: 'current authority' });
    assert.equal((await done).status, 'ready');
    assert.equal(opens, 2);
  } finally {
    await cache.dispose();
  }
});
