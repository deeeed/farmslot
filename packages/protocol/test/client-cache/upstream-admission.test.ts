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
  for (const method of ['run.list', 'pr.monitor', 'pr.addComment', 'unregistered'])
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

test('PR reads advertise only the implemented passive observation contract', () => {
  const query = resourceQuery('pr.list');
  assert.equal(query.live, true);
  assert.equal(query.persisted, true);
  assert.equal(query.maxBytes, 2 * 1024 * 1024);
  assert.deepEqual(resourceDependenciesForRead('pr.list', {}), query.dependencies);
  assert.throws(() => resourceQuery('pr.list', { force: true }));
});

test('PR detail reads are GitHub collectors whose forced checks stay explicit reads', () => {
  const status = resourceCollectorQuery('pr.status', { project: 'one', pr: 7, force: false });
  assert.equal(status.id, 'pr.status:{"pr":7,"project":"one"}');
  assert.throws(() => resourceCollectorQuery('pr.status', { pr: 7, project: 'one', force: true }));
  assert.throws(() => resourceCollectorQuery('pr.status', { pr: 7 }));
  const query = resourceQuery('pr.status', { pr: 7, project: 'one' });
  assert.equal(query.collector, 'github');
  assert.equal(query.persisted, true);
  assert.equal(query.retention?.cohort, resourceQuery('pr.list').retention?.cohort);
  assert.deepEqual(query.dependencies[0], {
    family: 'upstream',
    integration: 'github',
    queryId: status.id,
  });
  for (const family of ['runs', 'configuration', 'sources'])
    assert(query.dependencies.some((key) => key.family === family));
  // A released forced read is stamped with the same observation; a refused identity has no key.
  assert.deepEqual(
    resourceDependenciesForRead('pr.status', { pr: 7, project: 'one', force: true }),
    query.dependencies,
  );
  assert.deepEqual(
    resourceDependenciesForRead('pr.status', { pr: 7 }),
    query.dependencies.slice(1),
  );

  const slot = resourceQuery('pr.forSlot', { slotId: 's1' });
  assert.deepEqual(slot.dependencies[0], {
    family: 'upstream',
    integration: 'github',
    queryId: 'pr.forSlot:{"slotId":"s1"}',
  });
  assert(slot.dependencies.some((key) => key.family === 'slots'));
  assert.throws(() => resourceCollectorQuery('pr.forSlot', { slotId: 's1', force: true }));

  const threads = resourceQuery('pr.reviewComments', { repo: 'org/one', pr: 7 });
  assert.deepEqual(threads.dependencies, [
    {
      family: 'upstream',
      integration: 'github',
      queryId: 'pr.reviewComments:{"pr":7,"repo":"org/one"}',
    },
  ]);
  assert.throws(() => resourceCollectorQuery('pr.reviewComments', { pr: 7, repo: 'org' }));
  const stored = threads.persistedData?.({
    threads: [],
    currentUser: 'reviewer',
    observation: { status: 'stale', observedAt: 1, error: { code: 'X', message: 'gh stderr' } },
  }) as { observation: { error: { message: string } } };
  assert.notEqual(stored.observation.error.message, 'gh stderr');
});

test('only explicit non-upstream answers may omit a source observation', () => {
  const slot = resourceQuery('pr.forSlot', { slotId: 's1' });
  assert.equal(
    slot.sourceObservation?.({ pr: null, repo: null, baseRef: 'main', source: 'local' }),
    null,
  );
  assert.equal(slot.sourceObservation?.({ pr: 7, repo: 'org/one', baseRef: 'main' }), undefined);
  const stored = slot.persistedData?.({ pr: null, repo: null, baseRef: 'main', source: 'local' });
  assert.equal((stored as { source?: string }).source, 'local');
  const catalog = resourceQuery('runner.modelCatalog', { runner: 'claude' });
  const answer = { runner: 'claude', models: [] };
  assert.equal(
    catalog.sourceObservation?.({ ...answer, status: 'unsupported', source: 'unsupported' }),
    null,
  );
  for (const [status, source] of [
    ['ready', 'structured-file'],
    ['ready', 'catalog-command'],
    ['unavailable', 'unavailable'],
    ['unsupported', 'structured-file'],
  ])
    assert.equal(catalog.sourceObservation?.({ ...answer, status, source }), undefined);
  assert.equal(
    resourceQuery('pr.status', { pr: 1, project: 'one' }).sourceObservation?.({}),
    undefined,
  );
});

test('gateway status uses the same admission/retention contract and excludes force checks', () => {
  const query = resourceCollectorQuery('gateway.status', { refresh: false });
  assert.equal(query.id, resourceCollectorQuery('gateway.status').id);
  assert.throws(() => resourceCollectorQuery('gateway.status', { refresh: true }));
  assert.throws(() => resourceCollectorQuery('gateway.status', { token: 'private' }));
  const status = resourceQuery('gateway.status');
  assert.equal(status.live, true);
  assert.deepEqual(resourceCollectorReadMethods(), [
    'gateway.status',
    'config.githubAccounts',
    'pr.list',
    'pr.status',
    'pr.forSlot',
    'pr.reviewComments',
    'runner.modelCatalog',
    'providerAccounts.snapshot',
  ]);
  assert.equal(status.retention?.cohort, resourceQuery('pr.list').retention?.cohort);
  assert.deepEqual(status.dependencies, [{ family: 'gateway-update', scope: 'gateway' }]);
});

test('GitHub accounts share the upstream contract and persist only verified identity fields', () => {
  const query = resourceCollectorQuery('config.githubAccounts', { refresh: false });
  assert.equal(query.id, resourceCollectorQuery('config.githubAccounts').id);
  assert.throws(() => resourceCollectorQuery('config.githubAccounts', { refresh: true }));
  assert.throws(() => resourceCollectorQuery('config.githubAccounts', { host: 'github.com' }));
  const accounts = resourceQuery('config.githubAccounts');
  assert.equal(accounts.live, true);
  assert.equal(accounts.retention?.cohort, resourceQuery('pr.list').retention?.cohort);
  assert.deepEqual(accounts.dependencies, [
    { family: 'upstream', integration: 'github', queryId: query.id },
  ]);
  const stored = accounts.persistedData?.({
    accounts: [{ host: 'github.com', login: 'reader', active: true, token: 'private' }],
    checkedAt: '2026-10-26T00:00:00.000Z',
    observation: { status: 'ready', observedAt: 1000 },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), {
    accounts: [{ host: 'github.com', login: 'reader', active: true }],
    checkedAt: '2026-10-26T00:00:00.000Z',
    observation: { status: 'ready', observedAt: 1000 },
  });
});

test('runner model catalogs are provider collectors keyed by their canonical runner query', () => {
  const descriptor = resourceCollectorQuery('runner.modelCatalog', { runner: 'claude-code' });
  assert.equal(
    descriptor.id,
    resourceCollectorQuery('runner.modelCatalog', { runner: 'claude' }).id,
  );
  const query = resourceQuery('runner.modelCatalog', { runner: 'claude-code' });
  assert.equal(query.collector, 'providers');
  assert.equal(query.live, true);
  assert.equal(query.retention?.cohort, resourceQuery('pr.list').retention?.cohort);
  assert.deepEqual(query.dependencies, [
    { family: 'upstream', integration: 'providers', queryId: descriptor.id },
  ]);
  assert.deepEqual(
    resourceDependenciesForRead('runner.modelCatalog', { runner: 'claude-code' }),
    query.dependencies,
  );
  for (const params of [
    {},
    { runner: 'cursor', refresh: true },
    { runner: 'cursor', command: 'x' },
  ])
    assert.throws(() => resourceCollectorQuery('runner.modelCatalog', params));
  const stored = query.persistedData?.({
    runner: 'cursor',
    status: 'ready',
    source: 'catalog-command',
    models: [{ id: 'auto', label: 'Auto', reasoningModes: [], listed: true, stdout: 'raw' }],
    observation: { status: 'ready', observedAt: 1000 },
    command: '/private/cursor-agent',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(stored)), {
    runner: 'cursor',
    status: 'ready',
    source: 'catalog-command',
    models: [{ id: 'auto', label: 'Auto', reasoningModes: [], listed: true }],
    observation: { status: 'ready', observedAt: 1000 },
  });
});

test('visible-model preferences are reader-owned observations and SET stays a command', () => {
  const query = resourceQuery(
    'runner.visibleModels.get',
    { runner: 'pi', selectedModel: 'anthropic/claude-opus-5' },
    'reader',
  );
  assert.deepEqual(query.params, { runner: 'pi', selectedModel: 'anthropic/claude-opus-5' });
  assert.equal(query.collector, undefined);
  assert.equal(query.persisted, true);
  assert.deepEqual(query.dependencies, [{ family: 'profiles', scope: 'owner', ownerId: 'reader' }]);
  assert.equal(
    resourceQuery('runner.visibleModels.get', { runner: 'claude-code' }, 'reader').id,
    resourceQuery('runner.visibleModels.get', { runner: 'claude' }, 'reader').id,
  );
  assert.throws(() => resourceQuery('runner.visibleModels.get', {}), /authenticated reader/);
  assert.throws(() => resourceCollectorQuery('runner.visibleModels.get', {}));
  assert.throws(() => resourceQuery('runner.visibleModels.set' as never, { runner: 'pi' }));
  const stored = query.persistedData?.({
    runners: [
      {
        runner: 'pi',
        defaultModel: 'anthropic/claude-opus-5',
        defaultConfigured: false,
        configured: false,
        models: ['anthropic/claude-opus-5'],
        pickerModels: ['anthropic/claude-opus-5'],
        home: '/private/.farmslot',
      },
    ],
  });
  assert.equal(JSON.stringify(stored).includes('private'), false);
});

test('provider seats share one machine-keyed collector and keep force probes imperative', () => {
  const all = resourceCollectorQuery('providerAccounts.snapshot', { machines: [] });
  assert.equal(all.id, resourceCollectorQuery('providerAccounts.snapshot').id);
  const pair = resourceCollectorQuery('providerAccounts.snapshot', {
    machines: ['mini', 'macwork', 'mini'],
    forceRefresh: false,
  });
  assert.deepEqual(pair.params, { machines: ['macwork', 'mini'] });
  for (const params of [
    { forceRefresh: true },
    { machines: ['../private'] },
    { machines: ['macwork'], ownerId: 'foreign' },
  ])
    assert.throws(() => resourceCollectorQuery('providerAccounts.snapshot', params));
  const query = resourceQuery('providerAccounts.snapshot', { machines: ['mini'] });
  assert.equal(query.collector, 'providers');
  assert.equal(query.live, true);
  assert.equal(query.retention?.cohort, resourceQuery('pr.list').retention?.cohort);
  assert.deepEqual(query.dependencies, [
    {
      family: 'upstream',
      integration: 'providers',
      queryId: resourceCollectorQuery('providerAccounts.snapshot', { machines: ['mini'] }).id,
    },
  ]);
  assert.deepEqual(resourceQuery('providerAccounts.snapshot').dependencies, [
    { family: 'upstream', integration: 'providers', queryId: all.id },
    { family: 'slots', scope: 'farm' },
  ]);
  // The explicit Refresh read is stamped from raw params without becoming an observer identity.
  assert.deepEqual(
    resourceDependenciesForRead('providerAccounts.snapshot', {
      machines: ['mini'],
      forceRefresh: true,
    }),
    query.dependencies,
  );
  const stored = query.persistedData?.({
    checkedAt: '2026-10-26T00:00:00.000Z',
    observation: { status: 'ready', observedAt: 1000 },
    machines: [
      {
        machine: 'mini',
        checkedAt: '2026-10-26T00:00:00.000Z',
        runners: [
          {
            runner: 'pi',
            status: 'error',
            activeLabel: null,
            error: 'ssh stderr',
            inventory: {
              status: 'available',
              scope: 'host-default',
              accounts: [],
              inspection: { command: 'pi auth check', description: 'copy' },
            },
            usage: null,
          },
        ],
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(stored), /stderr|inspection/);
  assert.deepEqual(query.sourceObservation?.(stored), { status: 'ready', observedAt: 1000 });
});
