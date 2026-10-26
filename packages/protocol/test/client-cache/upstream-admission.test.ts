import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resourceCollectorQuery,
  resourceCollectorReadMethods,
  resourceDependenciesForRead,
  resourceQuery,
} from '../../src/client-cache/index.js';

test('collector descriptors normalize through the one closed read registry', () => {
  const global = resourceCollectorQuery('pr.list', undefined);
  assert.equal(global.id, resourceCollectorQuery('pr.list', { force: false }).id);
  const scoped = resourceCollectorQuery('pr.list', { project: 'one', force: false });
  assert.deepEqual(scoped.params, { project: 'one' });
  assert.equal(scoped.id, resourceQuery('pr.list', { project: 'one' }).id);
  assert.notEqual(global.id, scoped.id);
  for (const method of ['run.list', 'pr.status', 'pr.addComment', 'unregistered'])
    assert.throws(() => resourceCollectorQuery(method, {}), /registered collector read/);
});

test('observer parameters cannot force a collector or supply ownership', () => {
  for (const params of [
    { force: true },
    { refresh: true },
    { ownerId: 'foreign' },
    { project: '' },
    { project: ' one ' },
    { project: 'x'.repeat(257) },
    { project: '../private' },
    { project: 'a/b' },
    [],
  ])
    assert.throws(() => resourceCollectorQuery('pr.list', params));
});

test('PR source identities match normalized collectors and preserve local overlay dependencies', () => {
  const descriptor = resourceCollectorQuery('pr.list', { project: 'one', force: false });
  const query = resourceQuery('pr.list', { project: 'one' });
  assert.deepEqual(query.dependencies[0], {
    family: 'upstream',
    integration: 'github',
    queryId: descriptor.id,
  });
  assert.notDeepEqual(
    query.dependencies[0],
    resourceQuery('pr.list', { project: 'two' }).dependencies[0],
  );
  for (const family of ['runs', 'slots', 'workers', 'configuration', 'sources'])
    assert(query.dependencies.some((key) => key.family === family));
});

test('admission infrastructure does not claim unstaged PR reads are live', () => {
  const query = resourceQuery('pr.list');
  assert.equal(query.live, false);
  assert.equal(query.persisted, true);
  assert.equal(query.maxBytes, 2 * 1024 * 1024);
  assert.equal(resourceDependenciesForRead('pr.list', {}), undefined);
});

test('gateway status uses the same admission/retention contract and excludes force checks', () => {
  const query = resourceCollectorQuery('gateway.status', { refresh: false });
  assert.equal(query.id, resourceCollectorQuery('gateway.status').id);
  assert.throws(() => resourceCollectorQuery('gateway.status', { refresh: true }));
  assert.throws(() => resourceCollectorQuery('gateway.status', { token: 'private' }));
  const status = resourceQuery('gateway.status');
  assert.equal(status.live, true);
  assert.deepEqual(resourceCollectorReadMethods(), ['gateway.status']);
  assert.equal(status.retention?.cohort, resourceQuery('pr.list').retention?.cohort);
  assert.deepEqual(status.dependencies, [{ family: 'gateway-update', scope: 'gateway' }]);
});
