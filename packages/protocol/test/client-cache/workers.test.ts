import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGatewayResourceCache,
  RESOURCE_PUBLISH_INTERVAL_MS,
  type ResourceCacheTransport,
  resourceDependenciesForRead,
  resourceQuery,
  type ResourceQueryState,
  type ResourceReadResult,
} from '../../src/client-cache/index.js';
import type { ResourceChangedPayload } from '../../src/transport/events.js';

test('worker inventory filters have one canonical identity and retain node dependencies', () => {
  const first = resourceQuery('tmux.worker.list', { machine: 'b', machines: ['a', 'b'] });
  const second = resourceQuery('tmux.worker.list', {
    machines: ['b', 'a'],
    includeDisconnected: true,
  });
  assert.equal(first.id, second.id);
  assert.deepEqual(first.params, { includeDisconnected: true, machines: ['a', 'b'] });
  assert.deepEqual(first.dependencies, [
    { family: 'workers', scope: 'farm' },
    { family: 'workers', nodeId: 'a' },
    { family: 'workers', nodeId: 'b' },
  ]);
  assert.deepEqual(
    resourceDependenciesForRead(first.method, { machine: 'a', machines: ['b'] }),
    first.dependencies,
  );
  assert.equal(
    resourceQuery('tmux.worker.list', {}).id,
    resourceQuery('tmux.worker.list', { machines: [], includeDisconnected: true }).id,
  );
  assert.equal(first.persisted, false);
  assert.equal(first.live, true);
  assert.equal(RESOURCE_PUBLISH_INTERVAL_MS.workers, 200);
  for (const params of [
    { forceRefresh: true },
    { machine: '' },
    { machines: ['a', 1] },
    { includeDisconnected: 1 },
  ])
    assert.throws(() => resourceQuery('tmux.worker.list', params));
  assert.equal(resourceDependenciesForRead('tmux.worker.endSession', {}), undefined);
});

test('equivalent inventory observers share reads and a held invalidation leaves one follow-up', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  t.mock.method(performance, 'now', () => Date.now());
  let changed: ((payload: ResourceChangedPayload) => void) | undefined;
  let revision = 0;
  const pending: Array<(value: { workers: string[] }) => void> = [];
  let reads = 0;
  const query = resourceQuery<{ workers: string[] }>('tmux.worker.list', { machine: 'node' });
  const transport: ResourceCacheTransport = {
    getConnection: () => ({
      id: 1,
      connected: true,
      authMode: 'token',
      scope: { gatewayUrl: 'ws://worker.test', principalId: 'operator', principalGeneration: 0 },
      authority: { workspaceAccess: 'farm', roles: [] },
      capabilities: {
        httpBearerAuth: true,
        voiceInstructionFormatting: false,
        resourceChanges: {
          version: 1,
          epoch: 'worker-epoch',
          versionLists: false,
          observedReads: 1,
        },
      },
    }),
    onConnectionChange: () => () => {},
    onResourceChanged: (listener) => {
      changed = listener;
      return () => {
        changed = undefined;
      };
    },
    request<T>() {
      reads++;
      const sampled = revision;
      return new Promise<ResourceReadResult<T>>((resolve) =>
        pending.push((data) =>
          resolve({
            data: data as T,
            resourceState: {
              epoch: 'worker-epoch',
              dependencies: query.dependencies.map((key) => ({ key, revision: sampled })),
            },
          }),
        ),
      );
    },
    resynchronize: () => assert.fail('The source epoch did not change'),
  };
  const cache = createGatewayResourceCache({ transport });
  const states: ResourceQueryState<{ workers: string[] }>[] = [];
  const first = cache.observe(query, (state) => states.push(state));
  const second = cache.observe(
    resourceQuery('tmux.worker.list', { machines: ['node'], includeDisconnected: true }),
    () => {},
  );
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    await flush();
    assert.equal(reads, 1);
    revision++;
    changed!({
      version: 1,
      epoch: 'worker-epoch',
      changes: query.dependencies.map((key) => ({ key, revision, kind: 'updated' })),
    });
    pending.shift()!({ workers: ['old'] });
    await flush();
    assert.equal(reads, 1, 'The automatic follow-up respects the worker family interval');
    assert.equal(cache.read(query).status, 'stale');
    t.mock.timers.tick(RESOURCE_PUBLISH_INTERVAL_MS.workers!);
    await flush();
    assert.equal(reads, 2);
    assert.equal(cache.read(query).status, 'stale');
    pending.shift()!({ workers: ['current'] });
    await flush();
    assert.equal(cache.read(query).status, 'ready');
    assert.deepEqual(cache.read(query).data?.workers, ['current']);
    assert(!states.some((state) => state.status === 'ready' && state.data?.workers[0] === 'old'));
    await flush();
    assert.equal(reads, 2, 'An idle observed inventory has no recurring read');
    first();
    second();
    revision++;
    changed!({
      version: 1,
      epoch: 'worker-epoch',
      changes: [{ key: { family: 'workers', scope: 'farm' }, revision, kind: 'updated' }],
    });
    await flush();
    assert.equal(reads, 2, 'Inactive inventory does not read');
  } finally {
    first();
    second();
    await cache.dispose();
  }
});

test('an old gateway cannot bless worker inventory even if it would stamp a legacy read', async () => {
  let reads = 0;
  const query = resourceQuery('tmux.worker.list');
  const cache = createGatewayResourceCache({
    transport: {
      getConnection: () => ({
        id: 1,
        connected: true,
        authMode: 'none',
        scope: { gatewayUrl: 'ws://old.test' },
        authority: { workspaceAccess: 'farm', roles: [] },
        capabilities: {
          httpBearerAuth: false,
          voiceInstructionFormatting: false,
          resourceChanges: { version: 1, epoch: 'old', versionLists: false },
        },
      }),
      onConnectionChange: () => () => {},
      onResourceChanged: () => () => {},
      request: async <T>() => {
        reads++;
        return { data: {} as T };
      },
      resynchronize: () => assert.fail('No reconnect expected'),
    },
  });
  const unsubscribe = cache.observe(query, () => {});
  try {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cache.read(query).status, 'unsupported');
    assert.equal(reads, 0);
    await cache.retry(query);
    assert.equal(reads, 0, 'Retry never restores polling against unsupported dispatch');
  } finally {
    unsubscribe();
    await cache.dispose();
  }
});
