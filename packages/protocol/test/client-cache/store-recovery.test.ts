import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
  type ResourceStore,
} from '../../src/client-cache/index.js';
import type { RunListParams, RunListResult } from '../../src/rpc/run.js';
import { storedRun } from '../fixtures/run.js';

test('a transient storage I/O error reopens persistence without a socket reconnect', async () => {
  const scope = {
    gatewayUrl: 'ws://recovery.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const saved = createMemoryResourceStore();
  const healthy: ResourceStore = { ...saved, persistent: true };
  let opens = 0;
  const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => {
      if (++opens > 1) return healthy;
      return {
        ...createMemoryResourceStore(),
        persistent: true,
        putQuery: async () => {
          throw new Error('SQLITE_IOERR');
        },
      };
    },
  });
  const stop = cache.observe(query, () => {});
  try {
    const first = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'before storage recovery' });
    await first;
    assert.equal(opens, 2, 'one immediate reopen must not wait for another socket lifecycle');
    assert.equal(cache.read(query).status, 'stale');
    const reread = await transport.nextRead();
    reread.resolve({ value: 'resynchronized' });
    const current = await cache.retry(query);
    assert.equal(current.status, 'ready');
    assert.equal(current.storageNotice, undefined);
    assert.deepEqual((await saved.getQuery(query.id))?.data, { value: 'resynchronized' });
  } finally {
    stop();
    await cache.dispose();
  }
});

test('a persistent outage gets one immediate attempt, then waits for a reconnect', async () => {
  const scope = {
    gatewayUrl: 'ws://recovery.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  let opens = 0;
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => {
      opens++;
      throw new Error('SQLITE_IOERR');
    },
  });
  const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };
  try {
    const first = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'current network data' });
    await first;
    assert.equal(opens, 2);
    assert.match(cache.read(query).storageNotice!, /SQLITE_IOERR/);
    const next = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'next network data' });
    await next;
    assert.equal(opens, 2, 'network reads must not create an I/O recovery loop');
  } finally {
    await cache.dispose();
  }
});

test('a hydrate I/O recovery and reconnect serialize opens and close every handle', async () => {
  const scope = {
    gatewayUrl: 'ws://recovery.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  let release!: () => void;
  let entered!: () => void;
  const opened = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opens = 0,
    active = 0,
    maximum = 0;
  const closed = new Set<number>();
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => {
      const id = ++opens;
      maximum = Math.max(maximum, ++active);
      try {
        if (id === 2) {
          entered();
          await held;
        }
        const memory = createMemoryResourceStore();
        return {
          ...memory,
          persistent: true,
          getQuery:
            id === 1
              ? async () => {
                  throw new Error('SQLITE_IOERR');
                }
              : memory.getQuery,
          close: async () => {
            closed.add(id);
            await memory.close();
          },
        };
      } finally {
        active--;
      }
    },
  });
  const query = resourceQuery<{ value: string }>('sources.status');
  const stop = cache.observe(query, () => {});
  try {
    await opened;
    transport.setConnection({ connected: false }, 'network');
    transport.setConnection({ connected: true, id: 2 });
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    const concurrent = maximum;
    release();
    const reading = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'current' });
    await reading;
    assert.equal(concurrent, 1, 'only one store factory may run at a time');
    assert.equal(cache.read(query).data?.value, 'current');
  } finally {
    release();
    stop();
    await cache.dispose();
  }
  assert.equal(closed.size, opens, 'every replaced or final handle must be closed');
});

test('a successful persistent write rearms recovery for a later failure on the same connection', async () => {
  const scope = {
    gatewayUrl: 'ws://recovery.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  let opens = 0,
    failNext = false;
  const stores: ResourceStore[] = [];
  const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => {
      const attempt = ++opens;
      const memory = createMemoryResourceStore();
      stores.push(memory);
      return {
        ...memory,
        persistent: true,
        async putQuery(entry) {
          if (attempt === 1 || failNext) {
            failNext = false;
            throw new Error('SQLite auto-aborted transaction');
          }
          await memory.putQuery(entry);
        },
      };
    },
  });
  const stop = cache.observe(query, () => {});
  try {
    const first = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'first failure' });
    await first;
    const healthy = await transport.nextRead();
    healthy.resolve({ value: 'persisted after recovery' });
    await cache.retry(query);
    assert.equal(opens, 2);
    assert.deepEqual((await stores[1].getQuery(query.id))?.data, {
      value: 'persisted after recovery',
    });
    failNext = true;
    const second = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'second failure' });
    await second;
    assert.equal(opens, 3, 'a later failure must not stay degraded until a socket reconnect');
    assert.equal(cache.read(query).status, 'stale');
    const current = await transport.nextRead();
    current.resolve({ value: 'fresh after second recovery' });
    const result = await cache.retry(query);
    assert.equal(result.status, 'ready');
    assert.equal(result.storageNotice, undefined);
    assert.deepEqual((await stores[2].getQuery(query.id))?.data, {
      value: 'fresh after second recovery',
    });
  } finally {
    stop();
    await cache.dispose();
  }
});

test('a healthy query cannot rearm an always-failing query into a reopen loop', async () => {
  const scope = {
    gatewayUrl: 'ws://recovery.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  };
  const connection = new ResourceCacheConformanceTransport(scope);
  connection.setConnection({
    connected: true,
    id: 1,
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      resourceChanges: {
        version: 1,
        epoch: 'conformance-epoch',
        versionLists: false,
        observedReads: 1,
      },
    },
  });
  const good = { ...resourceQuery<{ value: string }>('fleet.status'), persisted: true };
  const bad = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };
  let opens = 0,
    goodWrites = 0;
  const transport = {
    getConnection: connection.getConnection,
    onConnectionChange: connection.onConnectionChange,
    onResourceChanged: connection.onResourceChanged,
    resynchronize: connection.resynchronize,
    async request<T>(method: string) {
      const query = method === good.method ? good : bad;
      return {
        data: { value: method } as T,
        resourceState: {
          epoch: 'conformance-epoch',
          dependencies: query.dependencies.map((key) => ({ key, revision: 0 })),
        },
      };
    },
  };
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => {
      // Bound the red control itself; the assertion below must catch excess opens.
      if (++opens > 6) throw new Error('Stop unbounded recovery test');
      const memory = createMemoryResourceStore();
      return {
        ...memory,
        persistent: true,
        async putQuery(entry) {
          if (entry.id === bad.id) throw new Error('large row still cannot be persisted');
          goodWrites++;
          await memory.putQuery(entry);
        },
      };
    },
  });
  const stopGood = cache.observe(good, () => {}),
    stopBad = cache.observe(bad, () => {});
  try {
    await Promise.all([cache.retry(good), cache.retry(bad)]);
    for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert(goodWrites > 0, 'A healthy write must land beside the failed write');
    assert.equal(opens, 2, 'Only the failing write can confirm its own recovery');
    assert.match(cache.read(bad).storageNotice!, /large row still cannot be persisted/);
    assert.equal(
      cache.read(bad).data?.value,
      bad.method,
      'Fresh network values remain available in memory',
    );
  } finally {
    stopGood();
    stopBad();
    await cache.dispose();
  }
});

test('a refused oversized value cannot confirm recovery through a no-op write callback', async () => {
  const scope = {
    gatewayUrl: 'ws://recovery.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  };
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  let opens = 0,
    failNext = false;
  const query = {
    ...resourceQuery<{ value: string }>('sources.status'),
    persisted: true,
    maxBytes: 128,
  };
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => {
      const attempt = ++opens,
        memory = createMemoryResourceStore();
      return {
        ...memory,
        persistent: true,
        async putQuery(entry) {
          if (attempt === 1 || failNext) {
            failNext = false;
            throw new Error('Still cannot persist the row');
          }
          await memory.putQuery(entry);
        },
      };
    },
  });
  const stop = cache.observe(query, () => {});
  try {
    const first = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'first failure' });
    await first;
    query.maxBytes = 0;
    (await transport.nextRead()).resolve({ value: 'not admitted to persistence' });
    await cache.retry(query);
    query.maxBytes = 128;
    failNext = true;
    const next = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'same write still fails' });
    await next;
    assert.equal(opens, 2, 'An admission refusal is not a successful persistence confirmation');
    (await transport.nextRead()).resolve({ value: 'fresh in memory' });
    await cache.retry(query);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('a successful first page cannot confirm recovery while a later run-list page keeps failing', async () => {
  const scope = {
    gatewayUrl: 'ws://paged-recovery.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  };
  const connection = new ResourceCacheConformanceTransport(scope);
  connection.setConnection({
    connected: true,
    id: 1,
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      resourceChanges: { version: 1, epoch: 'epoch', versionLists: true },
    },
  });
  const runs = ['a', 'b', 'c', 'd'].map((id) => storedRun(id));
  let opens = 0,
    successfulPages = 0,
    failedPages = 0;
  const transport = {
    getConnection: connection.getConnection,
    onConnectionChange: connection.onConnectionChange,
    onResourceChanged: connection.onResourceChanged,
    resynchronize: connection.resynchronize,
    async request<T>(_method: string, params: unknown) {
      const input = params as RunListParams;
      const selected = input.versions
        ? []
        : runs.filter((run) => input.ids?.includes(run.id)).slice(0, 2);
      const data: RunListResult = {
        runs: selected,
        totalCount: runs.length,
        versions: (input.versions ? runs : selected).map((run) => ({ id: run.id, version: 'v1' })),
      };
      return {
        data: data as T,
        resourceState: {
          epoch: 'epoch',
          dependencies: [{ key: { family: 'runs' as const, scope: 'farm' as const }, revision: 1 }],
        },
      };
    },
  };
  const cache = createGatewayResourceCache({
    transport,
    openStore: async () => {
      if (++opens > 6) throw new Error('Stop unbounded multi-page test');
      const memory = createMemoryResourceStore();
      return {
        ...memory,
        persistent: true,
        async mergeRows(key, merge) {
          if (merge.upserts.some((row) => row.id === 'c')) {
            failedPages++;
            throw new Error('later page remains unavailable');
          }
          successfulPages++;
          await memory.mergeRows!(key, merge);
        },
      } satisfies ResourceStore;
    },
  });
  const query = resourceQuery<RunListResult>('run.list', { limit: 10 });
  const stop = cache.observe(query, () => {});
  try {
    await cache.retry(query);
    for (let i = 0; i < 40; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert(
      successfulPages >= 2,
      'Both persistent attempts must successfully commit their first page',
    );
    assert.equal(opens, 2, 'Only a complete refresh may confirm collection recovery');
    assert.equal(failedPages, 2);
    assert.deepEqual(
      cache
        .read(query)
        .data?.runs.map((run) => run.id)
        .sort(),
      ['a', 'b', 'c', 'd'],
      'Fresh rows must remain readable in memory',
    );
    assert.match(cache.read(query).storageNotice!, /later page remains unavailable/);
  } finally {
    stop();
    await cache.dispose();
  }
});
