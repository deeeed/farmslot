import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
  type ResourceQueryState,
} from '../../src/client-cache/index.js';

const scope = { gatewayUrl: 'ws://persistent.invalid/', principalId: 'p', principalGeneration: 0 };
const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };

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
