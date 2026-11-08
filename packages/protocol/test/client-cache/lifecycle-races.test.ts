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

for (const reason of ['network', 'background', 'unobserve'] as const) {
  test(`an accepted observation persists when its ready listener triggers ${reason}`, async () => {
    const store = createMemoryResourceStore();
    await store.putQuery({ id: query.id, data: { value: 'older' }, observedAt: 1, bytes: 17 });
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection({ connected: true, id: 1 });
    const cache = createGatewayResourceCache({ transport, store });
    let paused = false;
    let stop = () => {};
    stop = cache.observe(query, (state) => {
      if (state.status !== 'ready' || paused) return;
      paused = true;
      if (reason === 'unobserve') stop();
      else
        transport.setConnection(
          reason === 'network' ? { connected: false, id: 1 } : { foreground: false, id: 1 },
          reason,
        );
    });
    try {
      const pending = cache.retry(query);
      (await transport.nextRead()).resolve({ value: 'latest' });
      await pending;
      assert(paused);
      const visible = cache.read(query);
      assert.equal(visible.status, 'stale');
      assert.equal(visible.data?.value, 'latest');
      const saved = await store.getQuery<{ value: string }>(query.id);
      assert.equal(
        saved?.data.value,
        'latest',
        'Pausing a transport must not discard an already accepted snapshot',
      );
      assert.equal(saved?.observedAt, visible.observedAt);
    } finally {
      stop();
      await cache.dispose();
    }
  });
}

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

for (const failure of ['write', 'open', 'fallback'] as const) {
  test(`a reconnect restores persistence after a temporary store ${failure} failure`, async () => {
    const saved = createMemoryResourceStore();
    const healthy: ResourceStore = { ...saved, persistent: true };
    let opens = 0;
    const notices: Array<string | undefined> = [];
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection({ connected: true, id: 1 });
    const cache = createGatewayResourceCache({
      transport,
      onStorageNotice: (notice) => notices.push(notice),
      openStore: async () => {
        if (++opens > 1) return healthy;
        if (failure === 'open') throw new Error('temporary storage I/O error');
        if (failure === 'fallback') return createMemoryResourceStore();
        return {
          ...createMemoryResourceStore(),
          persistent: true,
          putQuery: async () => {
            throw new Error('temporary storage I/O error');
          },
        };
      },
    });
    try {
      const first = cache.retry(query);
      (await transport.nextRead()).resolve({ value: 'kept while storage is unavailable' });
      assert.equal((await first).data?.value, 'kept while storage is unavailable');
      if (failure !== 'fallback')
        assert.match(cache.read(query).storageNotice!, /temporary storage I\/O error/);
      assert.equal(opens, 1, 'Storage failures must not create an immediate retry loop');

      transport.setConnection({ connected: false }, 'network');
      assert.equal(cache.read(query).data?.value, 'kept while storage is unavailable');
      transport.setConnection({ connected: true, id: 2 });
      const reconnected = cache.retry(query);
      (await transport.nextRead()).resolve({ value: 'saved after storage recovered' });
      await reconnected;
      assert.equal(opens, 2, 'A reconnect must reopen the persistent store');
      assert.equal(cache.read(query).storageNotice, undefined);
      assert.equal(notices.at(-1), undefined, 'A persistent store clears the visible notice');
      assert.equal(
        (await saved.getQuery<{ value: string }>(query.id))?.data.value,
        'saved after storage recovered',
      );
    } finally {
      await cache.dispose();
    }
  });
}

test('reopening persistent storage keeps newer visible data through disconnect and reconnect', async () => {
  const saved = createMemoryResourceStore();
  await saved.putQuery({
    id: query.id,
    data: { value: 'older disk value' },
    observedAt: 1,
    bytes: 32,
  });
  // This map represents durable rows, which survive closing and reopening a handle.
  const healthy: ResourceStore = { ...saved, persistent: true, close: async () => {} };
  let opens = 0;
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => {
      if (++opens > 1) return healthy;
      return {
        ...healthy,
        putQuery: async () => {
          throw new Error('temporary storage I/O error');
        },
      };
    },
  });
  try {
    const first = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'newer visible value' });
    await first;
    transport.setConnection({ connected: false }, 'network');
    await cache.retry(query);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cache.read(query).data?.value, 'newer visible value');
    assert.equal(opens, 1, 'A disconnected cache must wait before reopening storage');
    transport.setConnection({ connected: true, id: 2 });
    const next = cache.retry(query);
    const read = await transport.nextRead();
    assert.equal(cache.read(query).data?.value, 'newer visible value');
    read.resolve({ value: 'current value' });
    await next;
    assert.equal((await saved.getQuery<{ value: string }>(query.id))?.data.value, 'current value');
  } finally {
    await cache.dispose();
  }
});

test('repeated memory fallbacks retain the active store and close every unused handle', async () => {
  const stores: ResourceStore[] = [];
  const closed: boolean[] = [];
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => {
      const index = stores.length;
      const store: ResourceStore = {
        ...createMemoryResourceStore(),
        close: async () => {
          closed[index] = true;
        },
      };
      stores.push(store);
      closed.push(false);
      return store;
    },
  });
  try {
    const first = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'retained fallback' });
    await first;
    for (let id = 2; id <= 3; id++) {
      transport.setConnection({ connected: false }, 'network');
      await cache.retry(query);
      transport.setConnection({ connected: true, id });
      const next = cache.retry(query);
      const read = await transport.nextRead();
      assert.equal(
        (await stores[0].getQuery<{ value: string }>(query.id))?.data.value,
        'retained fallback',
      );
      assert.deepEqual(closed, [false, ...stores.slice(1).map(() => true)]);
      read.resolve({ value: 'retained fallback' });
      await next;
    }
    assert.equal(stores.length, 3);
  } finally {
    await cache.dispose();
  }
  assert(closed.every(Boolean), 'Every acquired fallback handle must close');
});

test('an unsupported persistence identity does not reopen memory stores on every reconnect', async () => {
  const transport = new ResourceCacheConformanceTransport({ gatewayUrl: scope.gatewayUrl });
  transport.setConnection({ connected: true, id: 1 });
  const notices: Array<string | undefined> = [];
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => createMemoryResourceStore(),
    onStorageNotice: (notice) => notices.push(notice),
  });
  try {
    const first = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'gateway without identity' });
    await first;
    for (let id = 2; id <= 3; id++) {
      transport.setConnection({ connected: false }, 'network');
      await cache.retry(query);
      transport.setConnection({ connected: true, id });
      const next = cache.retry(query);
      (await transport.nextRead()).resolve({ value: 'gateway without identity' });
      await next;
    }
    assert.deepEqual(notices, [
      'Offline data will not survive a restart with this gateway version.',
    ]);
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
