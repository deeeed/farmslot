import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  readStoredResource,
  resourceQuery,
  type ResourceStoreScope,
} from '../../src/client-cache/index.js';

const scope: ResourceStoreScope = {
  gatewayUrl: 'ws://localhost:1234',
  principalId: 'a',
  principalGeneration: 0,
};

test('display reads return stored data offline without a transport request', async () => {
  const query = resourceQuery<{ value: string }>('sources.status');
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority: { roles: [], workspaceAccess: 'farm' } });
  await store.putQuery({ id: query.id, data: { value: 'saved' }, bytes: 17, observedAt: 123 });
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.connection.authority = { roles: [], workspaceAccess: 'farm' };
  const cache = createGatewayResourceCache({ transport, store });
  try {
    assert.deepEqual(await readStoredResource(() => cache, query), { value: 'saved' });
    assert.equal(transport.requestCount, 0);
    assert.equal(cache.read(query).status, 'stale');
    await assert.rejects(
      readStoredResource(() => undefined, query),
      /store is not open/,
    );
  } finally {
    await cache.dispose();
  }
});

test('a display read cannot publish the retired owner reply', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  let current: typeof cache | undefined = cache;
  try {
    const result = readStoredResource(() => current, resourceQuery('sources.status'));
    const pending = await transport.nextRead();
    current = undefined;
    pending.resolve({ value: 'retired owner' });
    await assert.rejects(result, /owner changed/);
  } finally {
    await cache.dispose();
  }
});
