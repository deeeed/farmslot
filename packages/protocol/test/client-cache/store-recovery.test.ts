import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
  type ResourceStore,
} from '../../src/client-cache/index.js';

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
