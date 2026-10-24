import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type GatewayResourceCache,
  resourceQuery,
  type ResourceQueryRetention,
  type ResourceStore,
} from '../../src/client-cache/index.js';

const scope = {
  gatewayUrl: 'ws://retention.invalid/',
  principalId: 'owner',
  principalGeneration: 0,
};

// Exercise the policy with the existing stamped conformance read before enabling run migration.
function detail(
  runId: string,
  retention: ResourceQueryRetention = { maxEntries: 50, maxBytes: 20 * 1024 * 1024 },
) {
  return { ...resourceQuery<{ value: string }>('sources.status', { runId }), retention };
}

async function read(
  cache: GatewayResourceCache,
  transport: ResourceCacheConformanceTransport,
  query: ReturnType<typeof detail>,
  value: string,
) {
  const done = cache.retry(query);
  (await transport.nextRead()).resolve({ value });
  return done;
}

test('the registered run detail policy caps the whole method at 50 entries and 20 MB', () => {
  assert.deepEqual(resourceQuery('run.get', { runId: 'run' }).retention, {
    maxEntries: 50,
    maxBytes: 20 * 1024 * 1024,
  });
});

test('migrated run collections and details admit stamped reads and bounded persistence', () => {
  for (const [method, maxBytes] of [
    ['run.list', 20 * 1024 * 1024],
    ['run.get', 20 * 1024 * 1024],
    ['decision.list', 10 * 1024 * 1024],
  ] as const) {
    const query = resourceQuery(method, method === 'run.get' ? { runId: 'retained' } : {});
    assert.equal(query.live, true, `${method} must receive a server read stamp`);
    assert.equal(query.persisted, true, `${method} must survive a cold start`);
    assert.equal(query.maxBytes, maxBytes);
    assert.equal(
      query.retention?.maxBytes,
      maxBytes,
      `${method} must bound all parameter variants together`,
    );
  }
});

test('the 51st detail evicts the oldest persisted observation while keeping its memory value', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  try {
    for (let index = 0; index < 51; index++) {
      t.mock.timers.tick(1);
      assert.equal(
        (await read(cache, transport, detail(String(index)), String(index))).status,
        'ready',
      );
    }
    const saved = await store.listQueries();
    assert.equal(saved.length, 50);
    assert.equal(await store.getQuery(detail('0').id), undefined);
    assert.equal(cache.read(detail('0')).data?.value, '0');
    assert(await store.getQuery(detail('50').id));
  } finally {
    await cache.dispose();
  }
});

test('aggregate byte eviction keeps the newest details and leaves unrelated methods alone', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const store = createMemoryResourceStore();
  const unrelated = resourceQuery('fleet.status');
  await store.putQuery({ id: unrelated.id, data: { value: 'fleet' }, observedAt: 1, bytes: 17 });
  const cache = createGatewayResourceCache({ transport, store });
  const bytes = new TextEncoder().encode(JSON.stringify({ value: 'data' })).byteLength;
  const retention = { maxEntries: 50, maxBytes: bytes * 2 };
  try {
    for (const id of ['first', 'second', 'third']) {
      t.mock.timers.tick(1);
      await read(cache, transport, detail(id, retention), 'data');
    }
    const saved = (await store.listQueries()).filter((entry) =>
      entry.id.startsWith('sources.status:'),
    );
    assert.equal(saved.length, 2);
    assert(saved.reduce((total, entry) => total + entry.bytes, 0) <= retention.maxBytes);
    assert.equal(await store.getQuery(detail('first').id), undefined);
    assert(await store.getQuery(unrelated.id));
  } finally {
    await cache.dispose();
  }
});

test('an oversized replacement stays in memory and removes its old disk value without evicting siblings', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  const retention = { maxEntries: 2, maxBytes: 100 };
  const query = detail('replace', retention);
  try {
    await read(cache, transport, query, 'old');
    await read(cache, transport, detail('keep', retention), 'sibling');
    assert.equal((await read(cache, transport, query, 'x'.repeat(101))).status, 'ready');
    assert.equal(cache.read(query).data?.value, 'x'.repeat(101));
    assert.equal(await store.getQuery(query.id), undefined);
    assert(await store.getQuery(detail('keep').id));
  } finally {
    await cache.dispose();
  }
});

test('concurrent replies never exceed the group bound between committed writes', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const memory = createMemoryResourceStore();
  const counts: number[] = [];
  const store: ResourceStore = {
    ...memory,
    get deleted() {
      return memory.deleted;
    },
    listQueries: async () => {
      const snapshot = await memory.listQueries();
      await new Promise<void>((resolve) => setImmediate(resolve));
      return snapshot;
    },
    putQuery: async (entry) => {
      await memory.putQuery(entry);
      counts.push((await memory.listQueries()).length);
    },
  };
  const cache = createGatewayResourceCache({ transport, store });
  const retention = { maxEntries: 1, maxBytes: 100 };
  try {
    const first = cache.retry(detail('first', retention));
    const second = cache.retry(detail('second', retention));
    const a = await transport.nextRead();
    const b = await transport.nextRead();
    a.resolve({ value: 'first' });
    b.resolve({ value: 'second' });
    await Promise.all([first, second]);
    assert.deepEqual(counts, [1, 1]);
    assert.equal(await memory.getQuery(detail('first').id), undefined);
    assert(await memory.getQuery(detail('second').id));
  } finally {
    await cache.dispose();
  }
});

for (const reason of ['principal-change', 'profile-change'] as const) {
  test(`a ${reason} cancels a paused retention job before closing its original store`, async () => {
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.setConnection({ connected: true, id: 1 });
    const memory = createMemoryResourceStore();
    let release!: () => void;
    let entering!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Retention job did not start')), 1000);
      entering = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    let writes = 0;
    let closes = 0;
    let deletions = 0;
    const store: ResourceStore = {
      ...memory,
      get deleted() {
        return memory.deleted;
      },
      listQueries: async () => {
        entering();
        await gate;
        return memory.listQueries();
      },
      putQuery: async (entry) => {
        writes++;
        await memory.putQuery(entry);
      },
      close: async () => {
        closes++;
        await memory.close();
      },
      deleteAll: async () => {
        deletions++;
        await memory.deleteAll();
      },
    };
    const cache = createGatewayResourceCache({ transport, store });
    const query = detail('run');
    try {
      const pending = cache.retry(query);
      (await transport.nextRead()).resolve({ value: 'former scope' });
      await entered;
      transport.setConnection(
        {
          id: 2,
          scope:
            reason === 'principal-change'
              ? { ...scope, principalId: 'other' }
              : { ...scope, profileId: 'other' },
        },
        reason,
      );
      assert.equal(cache.read(query).data, undefined);
      assert.equal(closes, 0, 'Scope cleanup must wait for the old operation to drain');
      release();
      await pending;
      if (reason === 'principal-change') {
        // Revocation needs a later authenticated connect before reads can resume.
        transport.setConnection({ connected: true, id: 3 });
      }
      const fresh = await read(cache, transport, query, 'current scope');
      assert.equal(fresh.status, 'ready');
      assert.equal(fresh.data?.value, 'current scope');
      assert.equal(writes, 0);
      assert.equal(closes, 1);
      assert.equal(deletions, reason === 'principal-change' ? 1 : 0);
    } finally {
      release();
      await cache.dispose();
    }
  });
}

test('an accepted not-found evicts the old profile before an error listener switches profiles', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const memory = createMemoryResourceStore();
  const query = detail('deleted');
  await memory.putQuery({ id: query.id, data: { value: 'old' }, observedAt: 1, bytes: 15 });
  let persistedAtClose: string[] | undefined;
  const store: ResourceStore = {
    ...memory,
    get deleted() {
      return memory.deleted;
    },
    close: async () => {
      persistedAtClose = (await memory.listQueries()).map((entry) => entry.id);
      await memory.close();
    },
  };
  const cache = createGatewayResourceCache({ transport, store });
  let switched = false;
  const stop = cache.observe(query, (state) => {
    if (state.error?.code !== 'NOT_FOUND' || switched) return;
    switched = true;
    stop();
    transport.setConnection({ id: 2, scope: { ...scope, profileId: 'other' } }, 'profile-change');
  });
  try {
    const pending = cache.retry(query);
    (await transport.nextRead()).reject('NOT_FOUND');
    await pending;
    await cache.dispose();
    assert(switched);
    assert.deepEqual(persistedAtClose, []);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('retention storage failure keeps current facts ready with a fallback notice', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const memory = createMemoryResourceStore();
  const store: ResourceStore = {
    ...memory,
    get deleted() {
      return memory.deleted;
    },
    persistent: true,
    listQueries: async () => {
      throw new Error('retention storage unavailable');
    },
  };
  const cache = createGatewayResourceCache({ transport, store });
  try {
    const state = await read(cache, transport, detail('run'), 'live facts');
    assert.equal(state.status, 'ready');
    assert.equal(state.data?.value, 'live facts');
    assert.match(
      state.storageNotice ?? '',
      /will not survive a restart: retention storage unavailable/,
    );
  } finally {
    await cache.dispose();
  }
});
