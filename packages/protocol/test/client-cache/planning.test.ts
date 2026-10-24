import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceDependenciesForRead,
  resourceQuery,
} from '../../src/client-cache/index.js';

test('planning collections persist within one aggregate 2 MB bound per collection', () => {
  for (const method of ['backlog.list', 'roadmap.list', 'workGraph.list'] as const) {
    const query = resourceQuery(method, { project: 'one', includeArchived: true });
    assert.equal(query.persisted, true);
    assert.equal(query.live, true);
    assert.equal(query.maxBytes, 2 * 1024 * 1024);
    assert.deepEqual(query.retention, {
      maxEntries: Number.MAX_SAFE_INTEGER,
      maxBytes: 2 * 1024 * 1024,
    });
    assert.deepEqual(resourceDependenciesForRead(method, query.params), query.dependencies);
  }
});

test('roadmap projections follow their authored item, backlog lineage, graph and run writers', () => {
  assert.deepEqual(resourceQuery('roadmap.list').dependencies, [
    { family: 'planning', collection: 'roadmap' },
    { family: 'planning', collection: 'backlog' },
    { family: 'runs', scope: 'farm' },
  ]);
  assert.deepEqual(resourceQuery('roadmap.get', { itemId: 'roadmap-item' }).dependencies, [
    { family: 'planning', collection: 'roadmap' },
    { family: 'planning', collection: 'roadmap', itemId: 'roadmap-item' },
    { family: 'planning', collection: 'backlog' },
    { family: 'planning', collection: 'work-graphs' },
    { family: 'runs', scope: 'farm' },
  ]);
  assert.equal(resourceQuery('roadmap.get', { itemId: 'roadmap-item' }).persisted, false);
  assert.equal(resourceQuery('workGraph.get', { graphId: 'graph' }).persisted, false);
});

test('a planning observation cannot perform a search or a forced refresh', () => {
  assert.throws(() => resourceQuery('roadmap.list', { search: 'private draft' }), /search/i);
  for (const method of ['backlog.list', 'roadmap.list', 'workGraph.list'] as const) {
    assert.throws(() => resourceQuery(method, { forceRefresh: true }), /forceRefresh/);
    assert.deepEqual(resourceQuery(method, { forceRefresh: false }).params, {});
  }
  assert.equal(resourceQuery('roadmap.list', { search: '' }).id, resourceQuery('roadmap.list').id);
  for (const method of [
    'backlog.create',
    'roadmap.save',
    'workGraph.schedulerTick',
    'backlog.upcoming',
    'dispatch.preview',
    'doctor.run',
  ])
    assert.equal(resourceDependenciesForRead(method, {}), undefined);
});

test('the dispatch queue is a persisted operator collection with a single stored observation', () => {
  const query = resourceQuery('dispatch.queue.list');
  assert.equal(query.persisted, true);
  assert.equal(query.live, true);
  assert.deepEqual(query.retention, { maxEntries: 1, maxBytes: 2 * 1024 * 1024 });
  assert.deepEqual(query.dependencies, [{ family: 'planning', collection: 'dispatch-queue' }]);
});

for (const method of [
  'backlog.list',
  'roadmap.list',
  'workGraph.list',
  'dispatch.queue.list',
  'config.projects',
] as const) {
  test(`revoking ${method} authority removes saved data before its held reply applies`, async () => {
    const scope = {
      gatewayUrl: 'ws://planning-authority.invalid/',
      principalId: 'planning-reader',
      principalGeneration: 0,
    };
    const query = resourceQuery<{ value: string }>(method);
    const transport = new ResourceCacheConformanceTransport(scope);
    transport.connection.capabilities = {
      ...transport.connection.capabilities!,
      resourceChanges: { ...transport.connection.capabilities!.resourceChanges!, observedReads: 1 },
    };
    const store = createMemoryResourceStore();
    await store.setMetadata({ scope, authority: transport.connection.authority! });
    await store.putQuery({
      id: query.id,
      data: { value: 'private saved planning' },
      observedAt: 123,
      bytes: 34,
    });
    const cache = createGatewayResourceCache({ transport, store });
    const stop = cache.observe(query, () => undefined);
    try {
      for (let turn = 0; turn < 30 && !cache.read(query).data; turn++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(cache.read(query).data?.value, 'private saved planning');
      assert.equal(cache.read(query).observedAt, 123);
      transport.setConnection({ connected: true, id: 1 });
      const pending = cache.retry(query);
      const held = await transport.nextRead();
      transport.setConnection(
        { connected: false, id: 2, authority: { roles: [], workspaceAccess: 'none' } },
        'principal-change',
      );
      assert.equal(cache.read(query).data, undefined, 'Revoke visible access synchronously');
      assert(held.signal.aborted, 'Revoke the old read before releasing its reply');
      for (let turn = 0; turn < 30 && !store.deleted; turn++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      assert(store.deleted, 'The previous authority SQLite namespace must be deleted');
      assert.deepEqual(await store.listQueries(), []);
      held.resolve({ value: 'private late planning reply' });
      await pending;
      assert.equal(cache.read(query).data, undefined);
      assert.deepEqual(await store.listQueries(), []);
    } finally {
      stop();
      await cache.dispose();
    }
  });
}
