import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceDependenciesForRead, resourceQuery } from '../../src/client-cache/index.js';

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
