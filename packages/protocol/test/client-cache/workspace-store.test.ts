import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
} from '../../src/client-cache/index.js';

const scope = {
  gatewayUrl: 'ws://workspace-store.invalid',
  principalId: 'a',
  principalGeneration: 0,
};
function transport() {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({
    connected: true,
    id: 1,
    capabilities: {
      ...transport.connection.capabilities!,
      resourceChanges: {
        version: 1,
        epoch: 'conformance-epoch',
        versionLists: false,
        observedReads: 1,
        workspaceReads: 1,
      },
    },
  });
  return transport;
}

test('oversized workspace observation stays in memory without persisting beyond shared content budget', async () => {
  const connection = transport();
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({
    transport: connection,
    store,
    contentBudgetBytes: 20,
  });
  const query = resourceQuery<{ value: string }>('fs.read', { slotId: 'slot', path: 'opened' });
  try {
    const reading = cache.retry(query);
    (await connection.nextRead()).resolve({ value: 'larger than remaining byte' });
    await reading;
    assert.equal(cache.read(query).data?.value, 'larger than remaining byte');
    assert.equal(await store.getQuery(query.id), undefined);
    assert.equal((await store.byteTotals()).queries, 0);
  } finally {
    await cache.dispose();
  }
});

test('opening saved query cannot touch a replacement principal after held hydration', async () => {
  const connection = transport();
  const backing = createMemoryResourceStore();
  const query = resourceQuery('fs.read', { slotId: 'slot', path: 'opened' });
  await backing.setMetadata({ scope, authority: connection.connection.authority! });
  await backing.putQuery({ id: query.id, data: { value: 'saved' }, bytes: 17, observedAt: 1 });
  let started!: () => void;
  let release!: () => void;
  const entering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const touches: string[] = [];
  const store = {
    ...backing,
    async getQuery<T>(id: string) {
      started();
      await held;
      return backing.getQuery<T>(id);
    },
    async touchQuery(id: string, at: number) {
      touches.push(id);
      await backing.touchQuery?.(id, at);
    },
  };
  const cache = createGatewayResourceCache({ transport: connection, store });
  const stop = cache.observe(query, () => {});
  await entering;
  connection.setConnection(
    { id: 2, connected: false, scope: { ...scope, principalId: 'replacement' } },
    'principal-change',
  );
  release();
  stop();
  await cache.dispose();
  assert.deepEqual(touches, []);
});
