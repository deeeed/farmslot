import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceDependenciesForRead,
  resourceQuery,
} from '../../src/client-cache/index.js';

test('projects have one aggregate 2 MiB persisted collection; previews and registration stay memory-only', () => {
  const projects = resourceQuery('config.projects');
  assert.equal(projects.persisted, true);
  assert.equal(projects.requiresObservedRead, true);
  assert.equal(projects.maxBytes, 2 * 1024 * 1024);
  assert.deepEqual(projects.retention, { maxEntries: 1, maxBytes: 2 * 1024 * 1024 });
  for (const query of [
    resourceQuery('config.pools'),
    resourceQuery('config.pool', { machine: 'machine-a' }),
    resourceQuery('config.pool.raw', { machine: 'machine-a' }),
    resourceQuery('config.project', { project: 'project-a' }),
    resourceQuery('config.templates', { project: 'project-a' }),
    resourceQuery('config.templatePreview', { project: 'project-a', flowType: 'dev' }),
    resourceQuery('config.templateOptions', { project: 'project-a', flowType: 'dev' }),
    resourceQuery('llm.config.get'),
    resourceQuery('llm.auth.list'),
    resourceQuery('llm.tiers'),
  ]) {
    assert.equal(query.persisted, false, query.method);
    assert.equal(query.live, true, query.method);
    assert.equal(query.requiresObservedRead, true, query.method);
    assert.deepEqual(resourceDependenciesForRead(query.method, query.params), query.dependencies);
  }
});

test('configuration identities contain only declared selectors; commands and D08 observations are absent', () => {
  assert.deepEqual(resourceQuery('config.project', { project: 'one' }).dependencies, [
    { family: 'configuration', scope: 'farm' },
    { family: 'configuration', scope: 'farm', project: 'one' },
    { family: 'sources', scope: 'farm' },
  ]);
  assert.throws(() => resourceQuery('config.projects', { search: 'private text' }), /credentials/);
  assert.throws(() => resourceQuery('config.pool', { machine: '../private' }), /selector/);
  assert.throws(
    () => resourceDependenciesForRead('config.project', { project: '../private' }),
    /selector/,
  );
  assert.throws(() => resourceQuery('llm.auth.list', { token: 'never-in-a-key' }), /credentials/);
  assert.throws(() => resourceQuery('config.templateOptions', { project: 'one' }), /flowType/);
  assert.equal(
    resourceQuery('config.templateOptions', {
      project: 'one',
      flowType: 'dev',
      platform: undefined,
    }).id,
    resourceQuery('config.templateOptions', { project: 'one', flowType: 'dev' }).id,
  );
  for (const method of [
    'config.slot.update',
    'config.pool.update',
    'llm.auth.add',
    'llm.auth.refresh',
    'llm.auth.test',
    'doctor.run',
  ])
    assert.equal(resourceDependenciesForRead(method, {}), undefined, method);
});

test('a cold project observation retains original age offline, then authority loss removes it', async () => {
  const scope = {
    gatewayUrl: 'ws://config.invalid/',
    principalId: 'operator',
    principalGeneration: 0,
  };
  const query = resourceQuery<{ projects: Array<{ name: string }> }>('config.projects');
  const store = createMemoryResourceStore();
  const transport = new ResourceCacheConformanceTransport(scope);
  const authority = transport.connection.authority!;
  await store.setMetadata({ scope, authority });
  await store.putQuery({
    id: query.id,
    data: { projects: [{ name: 'private-project' }] },
    observedAt: 123,
    bytes: 45,
  });
  const cache = createGatewayResourceCache({ transport, store });
  const stop = cache.observe(query, () => undefined);
  try {
    for (let turn = 0; turn < 30 && cache.read(query).data === undefined; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cache.read(query).status, 'stale');
    assert.equal(cache.read(query).observedAt, 123);
    assert.equal(cache.read(query).data?.projects[0]?.name, 'private-project');
    assert.equal(transport.requestCount, 0);
    transport.setConnection(
      { id: 2, authority: { roles: [], workspaceAccess: 'none' } },
      'principal-change',
    );
    for (let turn = 0; turn < 30; turn++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cache.read(query).data, undefined);
    assert.equal((await store.listQueries()).length, 0);
  } finally {
    stop();
    await cache.dispose();
  }
});
