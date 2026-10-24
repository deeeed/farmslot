import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
  type ResourceReadMethod,
  type ResourceReadResult,
} from '../../src/client-cache/index.js';

interface CollectionBytes {
  value: string;
}

class CollectionTransport extends ResourceCacheConformanceTransport {
  override async request<T>(
    method: ResourceReadMethod,
    params: unknown,
    signal: AbortSignal,
  ): Promise<ResourceReadResult<T>> {
    const reply = await super.request<T>(method, params, signal);
    return {
      ...reply,
      resourceState: {
        epoch: 'conformance-epoch',
        dependencies: resourceQuery(method, params).dependencies.map((key) => ({
          key,
          revision: 0,
        })),
      },
    };
  }
}

function collectionBytes(bytes: number): CollectionBytes {
  const remaining = bytes - new TextEncoder().encode(JSON.stringify({ value: '' })).byteLength;
  // Multibyte content distinguishes the stored UTF-8 budget from a character limit.
  return { value: 'é'.repeat(Math.floor(remaining / 2)) + (remaining % 2 ? 'x' : '') };
}

for (const method of ['fleet.status', 'nodes.list'] as const) {
  test(`${method} persists exactly 2 MiB and removes an oversized replacement without evicting the other collection`, async () => {
    const transport = new CollectionTransport({
      gatewayUrl: 'ws://fleet-retention.invalid/',
      principalId: 'owner',
      principalGeneration: 0,
    });
    const capabilities = transport.getConnection().capabilities!;
    transport.setConnection({
      connected: true,
      id: 1,
      capabilities: {
        ...capabilities,
        resourceChanges: {
          version: 1,
          epoch: 'conformance-epoch',
          versionLists: false,
          observedReads: 1,
        },
      },
    });
    const store = createMemoryResourceStore();
    const cache = createGatewayResourceCache({ transport, store });
    const query = resourceQuery<CollectionBytes>(method);
    const other = resourceQuery<CollectionBytes>(
      method === 'fleet.status' ? 'nodes.list' : 'fleet.status',
    );
    const limit = 2 * 1024 * 1024;
    const read = async (selected: typeof query, data: CollectionBytes) => {
      const pending = cache.retry(selected);
      (await transport.nextRead()).resolve(data);
      const state = await pending;
      assert.equal(state.status, 'ready');
      assert.equal(state.data?.value, data.value);
    };
    try {
      await read(other, { value: 'unrelated collection' });
      for (const bytes of [limit - 1, limit]) {
        const data = collectionBytes(bytes);
        assert.equal(new TextEncoder().encode(JSON.stringify(data)).byteLength, bytes);
        await read(query, data);
        const saved = await store.getQuery(query.id);
        assert.equal(saved?.bytes, bytes);
        assert.deepEqual(saved?.data, data);
        assert.equal(saved?.observedAt, cache.read(query).observedAt);
      }
      const oversized = collectionBytes(limit + 1);
      await read(query, oversized);
      assert.equal(await store.getQuery(query.id), undefined);
      assert.equal(cache.read(query).data?.value, oversized.value);
      assert.deepEqual(
        (await store.listQueries()).map((entry) => entry.id),
        [other.id],
      );
      assert.deepEqual((await store.getQuery(other.id))?.data, { value: 'unrelated collection' });
    } finally {
      await cache.dispose();
    }
  });
}
