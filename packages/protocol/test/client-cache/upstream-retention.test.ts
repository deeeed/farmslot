import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  resourceQuery,
  type ResourceStore,
  UPSTREAM_QUERY_MAX_BYTES,
} from '../../src/client-cache/index.js';
import {
  isUpstreamStoredQuery,
  upstreamRetentionEvictions,
} from '../../src/client-cache/upstream-retention.js';

const scope = {
  gatewayUrl: 'ws://upstream-retention.invalid/',
  principalId: 'one',
  principalGeneration: 0,
};
const authority = {
  roles: [{ role: 'admin' as const, scope: { kind: 'global' as const } }],
  workspaceAccess: 'farm' as const,
};

test('cold hydration sweeps the aggregate upstream bound before exposing saved query rows', async () => {
  const memory = createMemoryResourceStore();
  const store: ResourceStore = {
    ...memory,
    persistent: true,
    get deleted() {
      return memory.deleted;
    },
  };
  await store.setMetadata({ scope, authority });
  const queries = ['oldest', 'middle'].map((project) =>
    resourceQuery<{ value: string }>('pr.list', { project }),
  );
  queries.push(resourceQuery<{ value: string }>('gateway.status'));
  for (let i = 0; i < queries.length; i++) {
    const data = {
      value: 'x'.repeat(800_000),
      observation: { status: 'ready', observedAt: i + 1 },
    };
    await store.putQuery({
      id: queries[i]!.id,
      data,
      observedAt: i + 1,
      bytes: Buffer.byteLength(JSON.stringify(data)),
    });
  }
  const unrelated = { id: resourceQuery('fleet.status').id, data: {}, observedAt: 1, bytes: 2 };
  await store.putQuery(unrelated);
  const transport = new ResourceCacheConformanceTransport(scope);
  const cache = createGatewayResourceCache({ transport, store });
  const oldest = cache.observe(queries[0]!, () => {});
  const newest = cache.observe(queries[2]!, () => {});
  try {
    const deadline = performance.now() + 1500;
    while (!cache.read(queries[2]!).data) {
      assert(performance.now() < deadline);
      await turn();
    }
    assert.equal(cache.read(queries[0]!).data, undefined);
    assert.equal(cache.read(queries[2]!).status, 'stale');
    assert.equal(cache.read(queries[2]!).observedAt, 3);
    const rows = (await store.listQueries()).filter((row) => isUpstreamStoredQuery(row.id));
    assert.equal(rows.length, 2);
    assert(rows.reduce((sum, row) => sum + row.bytes, 0) <= UPSTREAM_QUERY_MAX_BYTES);
    assert(await store.getQuery(unrelated.id));
    assert.equal(transport.requestCount, 0);
  } finally {
    oldest();
    newest();
    await cache.dispose();
  }
});

test('live retention groups project variants without deleting their rendered memory values', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  // The policy-only seam uses the existing stamped fixture, without enabling a production collector.
  const queries = ['first', 'second', 'third'].map((project) => ({
    ...resourceQuery<{ value: string }>('pr.list', { project }),
    collector: undefined,
    sourceObservation: undefined,
    live: true,
    dependencies: resourceQuery('sources.status').dependencies,
  }));
  try {
    for (const query of queries) {
      const done = cache.retry(query);
      (await transport.nextRead()).resolve({ value: 'x'.repeat(800_000) });
      await done;
    }
    assert.equal(await store.getQuery(queries[0]!.id), undefined);
    assert.equal(cache.read(queries[0]!).data?.value.length, 800_000);
    const saved = await store.listQueries();
    assert.equal(saved.length, 2);
    assert(saved.reduce((sum, row) => sum + row.bytes, 0) <= UPSTREAM_QUERY_MAX_BYTES);
  } finally {
    await cache.dispose();
  }
});

test('retention membership comes from the closed registry and cannot be supplied by an unknown stored method', () => {
  assert.equal(isUpstreamStoredQuery('unregistered:{}'), false);
  assert.equal(isUpstreamStoredQuery('fleet.status:{}'), false);
  assert.equal(isUpstreamStoredQuery(resourceQuery('pr.list', { project: 'one' }).id), true);
  const row = (project: string, observedAt: number) => ({
    id: resourceQuery('pr.list', { project }).id,
    data: {},
    observedAt,
    bytes: 1_100_000,
  });
  assert.deepEqual(upstreamRetentionEvictions([row('new', 2), row('old', 1)]), [row('old', 1).id]);
});

test('cold sweep discards an individually oversized row without evicting useful smaller observations', () => {
  const small = {
    id: resourceQuery('pr.list', { project: 'saved' }).id,
    observedAt: 1,
    bytes: 1000,
  };
  const large = {
    id: resourceQuery('gateway.status').id,
    observedAt: 2,
    bytes: UPSTREAM_QUERY_MAX_BYTES + 1,
  };
  assert.deepEqual(upstreamRetentionEvictions([small, large]), [large.id]);
});

test('gateway status retains source facts but excludes live diagnostics from the durable value', async () => {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({ connected: true, id: 1 });
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  const data = {
    value: 'fixture',
    version: '1',
    update: { localSha: 'aaaaaaa' },
    observation: { status: 'ready', observedAt: 1000 },
    githubQuerySpend: { points: 8 },
    listen: { host: 'private-listener' },
    futureDiagnostics: { value: 'ephemeral' },
  };
  const query = {
    ...resourceQuery<typeof data>('gateway.status'),
    collector: undefined,
    sourceObservation: undefined,
    live: true,
    dependencies: resourceQuery('sources.status').dependencies,
  };
  try {
    const done = cache.retry(query);
    (await transport.nextRead()).resolve(data);
    await done;
    assert.deepEqual(cache.read(query).data, data);
    assert.deepEqual((await store.getQuery(query.id))?.data, {
      version: '1',
      update: data.update,
      observation: data.observation,
    });
    assert.equal(data.githubQuerySpend.points, 8, 'Persistence must not mutate the live reply');
  } finally {
    await cache.dispose();
  }
});
