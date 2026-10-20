import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
  type ResourceStore,
  type ResourceStoreScope,
} from '../../src/client-cache/index.js';

const scope: ResourceStoreScope = {
  gatewayUrl: 'ws://localhost:1234',
  principalId: 'a',
  principalGeneration: 0,
};
const authority = { roles: [], workspaceAccess: 'farm' as const };
const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };

test('a reconnect queued immediately after sign-out cannot skip deletion', async () => {
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority });
  await store.putQuery({ id: query.id, data: { value: 'signed out' }, observedAt: 1, bytes: 22 });
  const transport = new ResourceCacheConformanceTransport(scope);
  const cache = createGatewayResourceCache({ transport, store });
  try {
    transport.setConnection({ connected: false }, 'sign-out');
    transport.setConnection({ connected: true, id: 1 });
    const done = cache.retry(query);
    const read = await transport.nextRead();
    assert(store.deleted);
    assert.equal(cache.read(query).data, undefined);
    read.resolve({ value: 'signed in again' });
    assert.equal((await done).status, 'ready');
  } finally {
    await cache.dispose();
  }
});

test('a ready listener switching principals cannot persist the previous reply', async () => {
  const memory = createMemoryResourceStore();
  let writes = 0;
  const store: ResourceStore = {
    ...memory,
    putQuery: async (entry) => {
      writes++;
      await memory.putQuery(entry);
    },
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport, store });
  let switched = false;
  cache.observe(query, (state) => {
    if (state.status === 'ready' && !switched) {
      switched = true;
      transport.setConnection({ id: 2, scope: { ...scope, principalId: 'b' } }, 'principal-change');
    }
  });
  try {
    const done = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'principal a' });
    await done;
    assert(switched);
    assert.equal(writes, 0);
    assert.equal(cache.read(query).data, undefined);
  } finally {
    await cache.dispose();
  }
});

test('external deletion clears observers immediately and drops the pending response', async () => {
  const store = createMemoryResourceStore();
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport, store });
  let visible: unknown;
  cache.observe(query, (state) => {
    visible = state.data;
  });
  try {
    const done = cache.retry(query);
    const read = await transport.nextRead();
    await store.deleteAll();
    assert.equal(visible, undefined);
    assert(read.signal.aborted);
    read.resolve({ value: 'deleted scope' });
    await done;
    assert.equal(cache.read(query).data, undefined);
  } finally {
    await cache.dispose();
  }
});

test('storage write failure retains the current in-memory value and a visible notice', async () => {
  const store: ResourceStore = {
    ...createMemoryResourceStore(),
    persistent: true,
    putQuery: async () => {
      throw new Error('disk full');
    },
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport, store });
  try {
    const done = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'still usable' });
    const state = await done;
    assert.equal(state.status, 'ready');
    assert.equal(state.data?.value, 'still usable');
    assert.match(state.storageNotice!, /will not survive a restart: disk full/);
  } finally {
    await cache.dispose();
  }
});

test('an old gateway is unsupported without a retry loop', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1, capabilities: undefined });
  const cache = createGatewayResourceCache({ transport });
  cache.observe(query, () => {});
  try {
    const done = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'old gateway' });
    assert.equal((await done).status, 'unsupported');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(transport.requestCount, 1);
  } finally {
    await cache.dispose();
  }
});

test('the store factory opens the initial authenticated scope before reading', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  let opened = 0;
  const cache = createGatewayResourceCache({
    transport,
    openStore: async (metadata) => {
      assert.equal(metadata.scope.principalId, 'a');
      opened++;
      return createMemoryResourceStore();
    },
  });
  try {
    const done = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'fresh' });
    await done;
    assert.equal(opened, 1);
  } finally {
    await cache.dispose();
  }
});
