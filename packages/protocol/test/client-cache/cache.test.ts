import assert from 'node:assert/strict';
import test from 'node:test';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
  type ResourceReadMethod,
  type ResourceReadResult,
  type ResourceStoreScope,
  resourceStoreScopeId,
} from '../../src/client-cache/index.js';
import type { ResourceKey } from '../../src/client-cache/keys.js';

const scope: ResourceStoreScope = {
  gatewayUrl: 'ws://localhost:1234',
  principalId: 'a',
  principalGeneration: 0,
};
const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };

test('an older connection response cannot replace newer ready data', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  try {
    const oldDone = cache.retry(query);
    const old = await transport.nextRead();
    transport.setConnection({ connected: false });
    transport.setConnection({ connected: true, id: 2 });
    const freshDone = cache.retry(query);
    const fresh = await transport.nextRead();
    fresh.resolve({ value: 'new connection' });
    assert.equal((await freshDone).status, 'ready');
    old.resolve({ value: 'old connection' });
    await oldDone;
    assert.equal(cache.read(query).data?.value, 'new connection');
    assert(old.signal.aborted);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('read errors survive disconnect and cached refresh until a successful replacement', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  try {
    const first = cache.retry(query);
    (await transport.nextRead()).reject('TIMEOUT');
    await first;
    transport.setConnection({ connected: false }, 'network');
    await cache.retry(query);
    assert.equal(cache.read(query).error?.code, 'TIMEOUT');
    assert.equal(transport.requestCount, 1);

    transport.setConnection({ connected: true, id: 2 });
    const reconnect = cache.retry(query);
    const next = await transport.nextRead();
    assert.equal(cache.read(query).status, 'loading');
    assert.equal(cache.read(query).error, undefined, 'A connected cold read clears its error');
    next.resolve({ value: 'saved' });
    await reconnect;

    const refresh = cache.retry(query);
    (await transport.nextRead()).reject('TIMEOUT');
    await refresh;
    transport.advance(1);
    const retry = cache.retry(query);
    const replacement = await transport.nextRead();
    assert.equal(cache.read(query).status, 'stale');
    assert.equal(cache.read(query).error?.code, 'TIMEOUT');
    assert.equal(cache.read(query).data?.value, 'saved');
    replacement.resolve({ value: 'recovered' }, 1);
    assert.equal((await retry).status, 'ready');
    assert.equal(cache.read(query).error, undefined);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('an unknown dependency conservatively schedules one follow-up', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  cache.observe(query, () => {});
  try {
    const firstDone = cache.retry(query);
    const first = await transport.nextRead();
    transport.publish({
      version: 1,
      epoch: 'conformance-epoch',
      changes: [
        {
          // A family from a newer gateway: no declared dependency can rule it out.
          key: { family: 'future-family', id: 'x' } as unknown as ResourceKey,
          revision: 1,
          kind: 'updated',
        },
      ],
    });
    first.resolve({ value: 'before unknown change' });
    assert.equal((await firstDone).status, 'stale');
    const followup = await transport.nextRead();
    const done = cache.retry(query);
    followup.resolve({ value: 'after unknown change' });
    assert.equal((await done).status, 'ready');
    assert.equal(transport.requestCount, 2);
  } finally {
    await cache.dispose();
  }
});

test('changes to known keys no query declares neither reread nor stale held data', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  const statuses: string[] = [];
  const stop = cache.observe(query, (state) => statuses.push(state.status));
  // Other slots and workspaces change several times a second on a busy farm.
  const otherSlotsChange = (revision: number) =>
    transport.publish({
      version: 1,
      epoch: 'conformance-epoch',
      changes: [
        { key: { family: 'slot', slotId: `other-${revision}` }, revision, kind: 'updated' },
        { key: { family: 'workspace', slotId: `other-${revision}` }, revision, kind: 'updated' },
      ],
    });
  try {
    const firstDone = cache.retry(query);
    const first = await transport.nextRead();
    otherSlotsChange(1);
    first.resolve({ value: 'held' });
    assert.equal((await firstDone).status, 'ready');
    statuses.length = 0;
    for (let revision = 2; revision < 20; revision++) otherSlotsChange(revision);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(cache.read(query).status, 'ready');
    assert.deepEqual(statuses, [], 'held data never turns stale');
    assert.equal(transport.requestCount, 1, 'no follow-up reads');
  } finally {
    stop();
    await cache.dispose();
  }
});

test('a negotiated read missing its stamp stays stale without a retry loop', async () => {
  class UnstampedTransport extends ResourceCacheConformanceTransport {
    override async request<T>(
      method: ResourceReadMethod,
      params: unknown,
      signal: AbortSignal,
    ): Promise<ResourceReadResult<T>> {
      return { data: (await super.request<T>(method, params, signal)).data };
    }
  }
  const transport = new UnstampedTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const cache = createGatewayResourceCache({ transport });
  cache.observe(query, () => {});
  try {
    const done = cache.retry(query);
    (await transport.nextRead()).resolve({ value: 'unstamped' });
    const state = await done;
    assert.equal(state.status, 'stale');
    assert.equal(state.error?.code, 'RESOURCE_STATE_MISSING');
    assert.equal(transport.requestCount, 1);
  } finally {
    await cache.dispose();
  }
});

test('oversized results remain in memory and do not persist', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  const small = { ...query, maxBytes: 2 };
  try {
    const done = cache.retry(small);
    (await transport.nextRead()).resolve({ value: 'larger than two bytes' });
    assert.equal((await done).status, 'ready');
    assert.equal(await store.getQuery(small.id), undefined);
  } finally {
    await cache.dispose();
  }
});

test('switching offline gateway profiles closes the old store without rendering or deleting it', async () => {
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority: { roles: [], workspaceAccess: 'farm' } });
  await store.putQuery({
    id: query.id,
    data: { value: 'other gateway' },
    observedAt: 1,
    bytes: 20,
  });
  const transport = new ResourceCacheConformanceTransport({
    ...scope,
    gatewayUrl: 'ws://other:4321',
  });
  const cache = createGatewayResourceCache({ transport, store });
  try {
    assert.equal((await cache.retry(query)).data, undefined);
    assert.equal(store.deleted, false);
  } finally {
    await cache.dispose();
  }
});

test('canonical query identities cover normalized params and exclude command registration', () => {
  assert.equal(
    resourceQuery('sources.status', { nodeId: 'n', sourceId: undefined }).id,
    resourceQuery('sources.status', { nodeId: 'n' }).id,
  );
  assert.equal(
    resourceQuery('sources.status', { nodeId: 'n', runId: 'r' }).id,
    resourceQuery('sources.status', { runId: 'r', nodeId: 'n' }).id,
  );
  assert.equal(
    resourceStoreScopeId({ gatewayUrl: 'ws://user:secret@localhost/#credential' }),
    resourceStoreScopeId({ gatewayUrl: 'ws://localhost/' }),
  );
});

test('fleet observations share one bounded persisted query and cannot execute refresh commands', () => {
  const fleet = resourceQuery('fleet.status');
  assert.equal(fleet.id, resourceQuery('fleet.status', { forceRefresh: false }).id);
  assert.deepEqual(fleet.params, {});
  assert.equal(fleet.live, true);
  assert.equal(fleet.persisted, true);
  assert.equal(fleet.maxBytes, 2 * 1024 * 1024);
  assert.deepEqual(fleet.retention, { maxEntries: 1, maxBytes: 2 * 1024 * 1024 });
  for (const params of [{ forceRefresh: true }, { forceRefresh: 'false' }, { unsupported: true }])
    assert.throws(() => resourceQuery('fleet.status', params), /forceRefresh/);
});

test('node inventory is one bounded persisted collection observation', () => {
  const nodes = resourceQuery('nodes.list');
  assert.equal(nodes.live, true);
  assert.equal(nodes.persisted, true);
  assert.deepEqual(nodes.dependencies, [{ family: 'node', scope: 'farm' }]);
  assert.deepEqual(nodes.retention, { maxEntries: 1, maxBytes: 2 * 1024 * 1024 });
});

test('capability catalog and status queries share registry/source dependencies and bounded retention', () => {
  for (const method of ['runtime.capability.list', 'runtime.capability.status'] as const) {
    const query = resourceQuery(method, { slotId: 'owned-slot' });
    assert.equal(query.live, true);
    assert.equal(query.persisted, true);
    assert.equal(query.maxBytes, 2 * 1024 * 1024);
    assert.equal(query.retention?.maxBytes, 2 * 1024 * 1024);
    assert.deepEqual(query.dependencies, [
      { family: 'capabilities' },
      { family: 'sources', scope: 'farm' },
    ]);
  }
});

test('task progress shares run/context observations and keeps slot-only reads scoped', () => {
  const query = resourceQuery('task.progress', {
    slotId: 'slot',
    runId: 'run',
    contextId: 'review',
  });
  assert.equal(query.live, true);
  assert.equal(query.persisted, true);
  assert.deepEqual(query.dependencies, [
    { family: 'progress', runId: 'run' },
    { family: 'run', runId: 'run' },
    { family: 'artifacts', runId: 'run' },
  ]);
  assert.deepEqual(resourceQuery('task.progress', { slotId: 'slot' }).dependencies, [
    { family: 'slot', slotId: 'slot' },
  ]);
  assert.deepEqual(
    resourceQuery('task.progress', { slotId: '', runId: 'workspace' }).dependencies[0],
    { family: 'progress', runId: 'workspace' },
  );
  assert.throws(() => resourceQuery('task.progress'), /requires slotId/);
});
