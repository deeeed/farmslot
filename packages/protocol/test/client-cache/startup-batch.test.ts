import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  readStoredQueryBatch,
  resourceQuery,
  storedQueryBatch,
} from '../../src/client-cache/index.js';

const scope = {
  gatewayUrl: 'ws://localhost:1234',
  principalId: 'operator',
  principalGeneration: 0,
};
const authority = { roles: [], workspaceAccess: 'farm' as const };
const query = resourceQuery<{ projects: [] }>('config.projects');

test('startup chooses recent queries without allowing one large body to crowd out smaller ones', () => {
  const rows = [
    { id: 'old', bytes: 3, observedAt: 1 },
    { id: 'too-large', bytes: 20, observedAt: 3 },
    { id: 'recent', bytes: 4, observedAt: 2 },
  ];
  assert.deepEqual(
    storedQueryBatch(rows, 7).map(({ id }) => id),
    ['recent', 'old'],
  );
});

test('an unseen query reads synchronously from the startup batch with no per-query read or RPC', async () => {
  const backing = createMemoryResourceStore();
  await backing.setMetadata({ scope, authority });
  await backing.putQuery({ id: query.id, data: { projects: [] }, bytes: 15, observedAt: 123 });
  let batches = 0;
  let individual = 0;
  let loaded!: () => void;
  const loadedBatch = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const store = {
    ...backing,
    persistent: true,
    async getQueries(maxBytes: number) {
      batches++;
      const rows = await readStoredQueryBatch(backing, maxBytes);
      loaded();
      return rows;
    },
    getQuery<T>(id: string) {
      individual++;
      return backing.getQuery<T>(id);
    },
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  const cache = createGatewayResourceCache({ transport, store });
  try {
    await loadedBatch;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(cache.read(query).data, { projects: [] });
    assert.equal(cache.read(query).status, 'stale');
    assert.equal(batches, 1);
    assert.equal(individual, 0);
    assert.equal(transport.requestCount, 0);
  } finally {
    await cache.dispose();
  }
});

test('a revoked owner cannot seed an entry from an outstanding startup batch', async () => {
  const backing = createMemoryResourceStore();
  await backing.setMetadata({ scope, authority });
  await backing.putQuery({ id: query.id, data: { projects: [] }, bytes: 15, observedAt: 123 });
  let started!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = {
    ...backing,
    persistent: true,
    async getQueries(maxBytes: number) {
      const batch = await readStoredQueryBatch(backing, maxBytes);
      started();
      await held;
      return batch;
    },
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  const cache = createGatewayResourceCache({ transport, store });
  let leaked = false;
  const stop = cache.observe(query, (state) => {
    if (state.data) leaked = true;
  });
  try {
    await reading;
    transport.setConnection({ scope: { ...scope, principalId: 'other' } });
    release();
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(leaked, false);
    assert.equal(cache.read(query).data, undefined);
  } finally {
    release();
    stop();
    await cache.dispose();
  }
});

test('the first restored query paint already has bounded aliased report bytes after a cold start', async () => {
  const backing = createMemoryResourceStore();
  await backing.setMetadata({ scope, authority });
  await backing.putQuery({ id: query.id, data: { projects: [] }, bytes: 15, observedAt: 123 });
  for (const [id, bytes, accessedAt] of [
    ['report', 20, 3],
    ['older', 20, 1],
    ['oversized', 40, 4],
  ] as const) {
    await backing.putContent({
      kind: 'artifact',
      id,
      data: new Uint8Array(bytes).fill(65),
      bytes,
      origin: 'prefetch',
      cohort: 'gate',
      accessedAt,
    });
    await backing.putContentAlias(id, { kind: 'artifact', id });
  }
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  const cache = createGatewayResourceCache({
    transport,
    store: { ...backing, persistent: true },
    contentBudgetBytes: 30,
  });
  let restored!: () => void;
  const painted = new Promise<void>((resolve) => {
    restored = resolve;
  });
  let firstReport: Uint8Array | undefined;
  let seen = false;
  const stop = cache.observe(query, (state) => {
    if (!state.data || seen) return;
    seen = true;
    firstReport = cache.peekContentByAlias?.('report');
    restored();
  });
  try {
    await painted;
    assert.equal(firstReport?.byteLength, 20, 'cached report is ready before its query can paint');
    assert.equal(
      cache.peekContentByAlias?.('older'),
      undefined,
      'startup respects the resident bound',
    );
    assert.equal(
      cache.peekContentByAlias?.('oversized'),
      undefined,
      'a large row cannot crowd out a report',
    );
    assert.equal(
      (await backing.listContent())[0].accessedAt,
      3,
      'warming does not mark a row opened',
    );
    assert.equal(transport.requestCount, 0);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('revocation during cold report hydration cannot restore the previous owner bytes', async () => {
  const backing = createMemoryResourceStore();
  await backing.setMetadata({ scope, authority });
  await backing.putQuery({ id: query.id, data: { projects: [] }, bytes: 15, observedAt: 123 });
  await backing.putContent({
    kind: 'artifact',
    id: 'report',
    data: new Uint8Array([65]),
    bytes: 1,
    origin: 'prefetch',
    cohort: 'gate',
    accessedAt: 123,
  });
  await backing.putContentAlias('private-report', { kind: 'artifact', id: 'report' });
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = {
    ...backing,
    persistent: true,
    async getContent(key: Parameters<typeof backing.getContent>[0]) {
      const saved = await backing.getContent(key);
      entered();
      await held;
      return saved;
    },
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = authority;
  const cache = createGatewayResourceCache({ transport, store });
  let leaked = false;
  const stop = cache.observe(query, (state) => {
    if (state.data) leaked = true;
  });
  try {
    await started;
    transport.setConnection({ scope: { ...scope, principalId: 'other' } });
    release();
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(leaked, false);
    assert.equal(cache.peekContentByAlias?.('private-report'), undefined);
  } finally {
    release();
    stop();
    await cache.dispose();
  }
});
