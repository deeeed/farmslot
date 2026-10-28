import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayResourceCache } from '../../src/client-cache/cache.js';
import type { ResourceReadStamp } from '../../src/client-cache/keys.js';
import { resourceQuery } from '../../src/client-cache/registry.js';
import {
  RUN_LIST_COLLECTION_ID,
  RunListCollection,
} from '../../src/client-cache/run-list-versions.js';
import {
  createMemoryResourceStore,
  type ResourceRowsMerge,
  type ResourceStore,
} from '../../src/client-cache/store.js';
import type {
  ResourceCacheConnection,
  ResourceCacheTransport,
  ResourceQueryState,
} from '../../src/client-cache/types.js';
import type { Run } from '../../src/contracts/runs.js';
import { Methods } from '../../src/rpc/registry.js';
import type { RunListParams, RunListResult } from '../../src/rpc/run.js';
import { runListPage, runListProjection } from '../../src/runs/run-list-filter.js';
import type { ResourceChangedPayload } from '../../src/transport/events.js';

function run(id: string, day: number, fields: Record<string, unknown> = {}): Run {
  return {
    id,
    status: 'done',
    flowType: 'dev',
    project: 'farm',
    ticketOrPr: `T-${id}`,
    familyId: `family-${id}`,
    lane: 'production',
    createdAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    updatedAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    slotId: null,
    steps: [],
    decisions: [],
    metrics: {},
    ...fields,
  } as unknown as Run;
}

const summaries = {
  summaryMeta: {
    scope: 'returned-runs' as const,
    summaryRunCount: 0,
    totalCount: 0,
    isTruncated: false,
  },
  familySummaries: [],
  projectAnalytics: [],
};

/** A gateway that follows the run.list version-list contract over a live map. */
function gateway(runs: Run[], versionLists = true) {
  const live = new Map(runs.map((value) => [value.id, value]));
  const versions = new Map(runs.map(({ id }) => [id, 'v1']));
  let revision = 1;
  let counter = 1;
  const calls: RunListParams[] = [];
  const unserved = new Set<string>();
  const servedVersion = new Map<string, string>();
  let pageSize = 100;
  let refuse: string | undefined;
  const changeListeners = new Set<(payload: ResourceChangedPayload) => void>();
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://runs.invalid/', principalId: 'owner', principalGeneration: 0 },
    authority: { roles: [{ role: 'admin', scope: { kind: 'global' } }], workspaceAccess: 'farm' },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      resourceChanges: { version: 1, epoch: 'epoch', versionLists },
    },
  };
  const stamp = (): ResourceReadStamp => ({
    epoch: 'epoch',
    dependencies: [{ key: { family: 'runs', scope: 'farm' }, revision }],
  });
  const transport: ResourceCacheTransport = {
    getConnection: () => connection,
    onConnectionChange: () => () => {},
    onResourceChanged(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    resynchronize: () => {},
    async request<T>(method: string, params: unknown) {
      assert.equal(method, Methods.RUN_LIST);
      const value = (params ?? {}) as RunListParams;
      calls.push(value);
      if (refuse) throw Object.assign(new Error(refuse), { code: refuse });
      const flags = value.includeFamilySummaries || value.includeProjectAnalytics ? summaries : {};
      if (value.versions) {
        const result: RunListResult = {
          runs: [],
          totalCount: live.size,
          versions: [...live.keys()].map((id) => ({ id, version: versions.get(id)! })),
          ...flags,
        };
        return { data: result as T, resourceState: stamp() };
      }
      if (value.ids) {
        const served = value.ids
          .filter((id) => live.has(id) && !unserved.has(id))
          .slice(0, pageSize);
        const result: RunListResult = {
          runs: served.map((id) => live.get(id)!),
          totalCount: served.length,
          versions: served.map((id) => ({
            id,
            version: servedVersion.get(id) ?? versions.get(id)!,
          })),
        };
        return { data: result as T, resourceState: stamp() };
      }
      return {
        data: { ...runListPage([...live.values()], value), ...flags } as T,
        resourceState: stamp(),
      };
    },
  };
  return {
    transport,
    calls,
    live,
    versions,
    unserved,
    servedVersion,
    setPageSize: (size: number) => (pageSize = size),
    refuse: (code: string | undefined) => (refuse = code),
    /** A run write: a new version and one runs change. */
    write(value: Run) {
      live.set(value.id, value);
      versions.set(value.id, `v${++counter}`);
      this.changed();
    },
    remove(id: string) {
      live.delete(id);
      versions.delete(id);
      this.changed();
    },
    changed() {
      revision++;
      for (const listener of changeListeners)
        listener({
          version: 1,
          epoch: 'epoch',
          changes: [{ key: { family: 'runs', scope: 'farm' }, revision, kind: 'updated' }],
        });
    },
    versionsOf: (id: string) => versions.get(id),
  };
}

async function flush() {
  for (let turn = 0; turn < 40; turn++) await new Promise((resolve) => setImmediate(resolve));
}

function observe<T>(cache: ReturnType<typeof createGatewayResourceCache>, params: RunListParams) {
  const states: Array<ResourceQueryState<T>> = [];
  const query = resourceQuery<T>(Methods.RUN_LIST, params);
  const stop = cache.observe(query, (state) => states.push(state));
  return { query, stop, last: () => states[states.length - 1] };
}

const reads = (calls: RunListParams[]) => ({
  versions: calls.filter((call) => call.versions).length,
  ids: calls.filter((call) => call.ids).map((call) => call.ids),
  full: calls.filter((call) => !call.versions && !call.ids).length,
});

const ids = (state: ResourceQueryState<RunListResult> | undefined) =>
  state?.data?.runs.map(({ id }) => id);

test('stored rows missing from the version reply are removed', async () => {
  const fake = gateway([run('a', 1), run('b', 2), run('c', 3)]);
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport: fake.transport, store });
  const history = observe<RunListResult>(cache, { limit: 1000 });
  await flush();
  assert.deepEqual((await store.getRows!(RUN_LIST_COLLECTION_ID)).rows.map(({ id }) => id).sort(), [
    'a',
    'b',
    'c',
  ]);
  fake.remove('b');
  await flush();
  const stored = await store.getRows!(RUN_LIST_COLLECTION_ID);
  assert.deepEqual(stored.rows.map(({ id }) => id).sort(), ['a', 'c']);
  assert.deepEqual(ids(history.last()), ['c', 'a']);
  assert.equal(history.last()?.data?.totalCount, 2);
  assert.equal(history.last()?.status, 'ready');
  // Removed rows are gone from memory too: listed again at the same version, b is read again.
  fake.calls.length = 0;
  fake.live.set('b', run('b', 2));
  fake.versions.set('b', 'v1');
  fake.changed();
  await flush();
  assert.deepEqual(reads(fake.calls).ids, [['b']]);
  assert.deepEqual((await store.getRows!(RUN_LIST_COLLECTION_ID)).rows.map(({ id }) => id).sort(), [
    'a',
    'b',
    'c',
  ]);
  history.stop();
  await cache.dispose();
});

test('one runs change is one versions read for every run.list view, reading only changed ids', async () => {
  const fake = gateway([
    run('a', 1, { status: 'running', tags: ['ux'] }),
    run('b', 2),
    run('c', 3, { tags: ['ux'] }),
  ]);
  const cache = createGatewayResourceCache({
    transport: fake.transport,
    store: createMemoryResourceStore(),
  });
  const views = [
    observe<RunListResult>(cache, { limit: 1000 }),
    observe<RunListResult>(cache, { active: true }),
    observe<RunListResult>(cache, { tags: ['ux'] }),
  ];
  await flush();
  assert.deepEqual(reads(fake.calls), { versions: 1, ids: [['a', 'b', 'c']], full: 0 });
  fake.calls.length = 0;
  fake.write(run('b', 2, { tags: ['ux'], summary: 'changed' }));
  await flush();
  assert.deepEqual(reads(fake.calls), { versions: 1, ids: [['b']], full: 0 });
  assert.deepEqual(
    views.map((view) => ids(view.last())),
    [['c', 'b', 'a'], ['a'], ['c', 'b', 'a']],
  );
  assert.ok(views.every((view) => view.last()?.status === 'ready'));
  for (const view of views) view.stop();
  await cache.dispose();
});

test('catch-up pages run in asked order after the last served id, missing ids asked once more', async () => {
  const fake = gateway(['a', 'b', 'c', 'd', 'e'].map((id, index) => run(id, index + 1)));
  fake.setPageSize(2);
  fake.unserved.add('b');
  const cache = createGatewayResourceCache({
    transport: fake.transport,
    store: createMemoryResourceStore(),
  });
  const history = observe<RunListResult>(cache, { limit: 1000 });
  await flush();
  // b, skipped before the last served id, is missing: asked once more, then left.
  assert.deepEqual(reads(fake.calls).ids, [['a', 'b', 'c', 'd', 'e'], ['d', 'e'], ['b']]);
  assert.equal(history.last()?.status, 'stale');
  assert.deepEqual(ids(history.last()), ['e', 'd', 'c', 'a']);
  assert.equal(history.last()?.data?.totalCount, 4);
  fake.calls.length = 0;
  fake.unserved.clear();
  fake.changed();
  await flush();
  assert.deepEqual(reads(fake.calls).ids, [['b']]);
  assert.equal(history.last()?.status, 'ready');
  assert.deepEqual(ids(history.last()), ['e', 'd', 'c', 'b', 'a']);
  history.stop();
  await cache.dispose();
});

test('a row served at a newer version is stored under it, and the view waits for its listing', async () => {
  const fake = gateway([run('a', 1), run('b', 2)]);
  fake.servedVersion.set('b', 'v-newer');
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport: fake.transport, store });
  const history = observe<RunListResult>(cache, { limit: 1000 });
  await flush();
  const stored = await store.getRows!(RUN_LIST_COLLECTION_ID);
  assert.equal(stored.rows.find(({ id }) => id === 'b')?.version, 'v-newer');
  assert.equal(history.last()?.status, 'stale');
  history.stop();
  await cache.dispose();
});

test('views take the version reply resource state and count totals from projections', async () => {
  const fake = gateway([
    run('a', 1, { status: 'running' }),
    run('b', 2, { project: 'other' }),
    run('c', 3, { summary: 'Login flow', tags: ['Ship'] }),
    run('d', 4, { project: 'other' }),
  ]);
  const cache = createGatewayResourceCache({
    transport: fake.transport,
    store: createMemoryResourceStore(),
  });
  const project = observe<RunListResult>(cache, { project: 'other', limit: 1 });
  const search = observe<RunListResult>(cache, { search: 'LOGIN', limit: 50 });
  const tagged = observe<RunListResult>(cache, { search: 'ship' });
  await flush();
  assert.deepEqual(ids(project.last()), ['d']);
  assert.equal(project.last()?.data?.totalCount, 2);
  assert.deepEqual(ids(search.last()), ['c']);
  // Tags match as the gateway stores them, not lowercased.
  assert.deepEqual(ids(tagged.last()), []);
  assert.equal(project.last()?.status, 'ready');
  assert.deepEqual(project.last()?.resourceState?.dependencies, [
    { key: { family: 'runs', scope: 'farm' }, revision: 1 },
  ]);
  assert.equal(reads(fake.calls).full, 0);
  for (const view of [project, search, tagged]) view.stop();
  await cache.dispose();
});

test('an unfiltered history view takes the version reply summaries; a filtered one reads its own', async () => {
  const fake = gateway([run('a', 1), run('b', 2, { project: 'other' })]);
  const cache = createGatewayResourceCache({
    transport: fake.transport,
    store: createMemoryResourceStore(),
  });
  const history = observe<RunListResult>(cache, {
    limit: 1000,
    includeFamilySummaries: true,
    includeProjectAnalytics: true,
  });
  await flush();
  assert.deepEqual(fake.calls[0], {
    versions: true,
    includeFamilySummaries: true,
    includeProjectAnalytics: true,
  });
  assert.deepEqual(history.last()?.data?.summaryMeta, summaries.summaryMeta);
  assert.equal(reads(fake.calls).full, 0);
  const filtered = observe<RunListResult>(cache, {
    project: 'other',
    includeFamilySummaries: true,
  });
  await flush();
  // A new view of a current collection reads nothing more than its own summaries.
  assert.deepEqual(reads(fake.calls), { versions: 1, ids: [['a', 'b']], full: 1 });
  assert.deepEqual(ids(filtered.last()), ['b']);
  history.stop();
  filtered.stop();
  await cache.dispose();
});

test('an empty store fills through pages, and a cold start serves the stored collection', async () => {
  const fake = gateway(['a', 'b', 'c'].map((id, index) => run(id, index + 1)));
  fake.setPageSize(1);
  const store = createMemoryResourceStore();
  const first = createGatewayResourceCache({ transport: fake.transport, store });
  const view = observe<RunListResult>(first, { limit: 1000 });
  await flush();
  assert.deepEqual(reads(fake.calls).ids, [['a', 'b', 'c'], ['b', 'c'], ['c']]);
  const saved = await store.getRows!(RUN_LIST_COLLECTION_ID);
  view.stop();
  await first.dispose();

  // A store the first cache wrote, read by a second one before any version reply.
  const offline = gateway([], true);
  const copy = createMemoryResourceStore();
  await copy.mergeRows!(RUN_LIST_COLLECTION_ID, {
    entry: saved.entry!,
    upserts: saved.rows,
    deletes: [],
  });
  const cold = createGatewayResourceCache({
    transport: {
      ...offline.transport,
      getConnection: () => ({ ...offline.transport.getConnection(), connected: false }),
    },
    store: copy,
  });
  const active = observe<RunListResult>(cold, { familyId: 'family-b' });
  await flush();
  assert.equal(active.last()?.status, 'stale');
  assert.deepEqual(ids(active.last()), ['b']);
  assert.equal(cold.runListProjections?.()?.length, 3);
  assert.deepEqual(offline.calls, []);
  active.stop();
  await cold.dispose();
});

test('stored rows without a body count as missing on the next connect', async () => {
  const fake = gateway([run('a', 1), run('b', 2)]);
  const store = createMemoryResourceStore();
  const projection = runListProjection(run('a', 1));
  await store.mergeRows!(RUN_LIST_COLLECTION_ID, {
    entry: { id: RUN_LIST_COLLECTION_ID, data: { totalCount: 2 }, observedAt: 1, bytes: 10 },
    upserts: [
      { id: 'a', version: 'v1', projection, bytes: 5 },
      {
        id: 'b',
        version: 'v1',
        projection: runListProjection(run('b', 2)),
        body: run('b', 2),
        bytes: 5,
      },
    ],
    deletes: [],
  });
  const cache = createGatewayResourceCache({ transport: fake.transport, store });
  const history = observe<RunListResult>(cache, { limit: 1000 });
  await flush();
  assert.deepEqual(reads(fake.calls).ids, [['a']]);
  assert.equal(history.last()?.status, 'ready');
  history.stop();
  await cache.dispose();
});

test('the run collection keeps active bodies first, then newest, within its body bound', async () => {
  const merges: ResourceRowsMerge[] = [];
  const live = [
    run('old', 2, { summary: 'x'.repeat(400) }),
    run('new', 3, { summary: 'x'.repeat(400) }),
    // The oldest run, but active, so its body is kept before newer finished ones.
    run('active', 1, { status: 'running', summary: 'x'.repeat(400) }),
  ];
  const size = (value: Run) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  // Room for two of the three bodies.
  const bodyBytes = size(live[1]) + size(live[2]);
  const collection = new RunListCollection({
    async request(params) {
      return params.versions
        ? {
            data: {
              runs: [],
              totalCount: 3,
              versions: live.map(({ id }) => ({ id, version: 'v1' })),
            },
          }
        : { data: { runs: live.filter(({ id }) => params.ids!.includes(id)), totalCount: 3 } };
    },
    async persist(merge) {
      merges.push(merge);
    },
    maxBodyBytes: bodyBytes,
  });
  await collection.refresh({});
  const last = merges[merges.length - 1];
  const bodies = new Map(last.upserts.map((row) => [row.id, row.body !== undefined]));
  assert.deepEqual(Object.fromEntries(bodies), { old: false, new: true, active: true });
  assert.ok(last.entry.bytes > bodyBytes);
  // In memory, every body stays: the bound is only on what is stored.
  assert.deepEqual(
    collection.view({ limit: 10 })?.runs.map(({ id }) => id),
    ['new', 'old', 'active'],
  );
});

test('many filtered views over the budget never evict the run collection or its rows', async () => {
  const fake = gateway([run('a', 1)], false);
  const store = createMemoryResourceStore();
  const mb = 1024 * 1024;
  await store.mergeRows!(RUN_LIST_COLLECTION_ID, {
    entry: { id: RUN_LIST_COLLECTION_ID, data: { totalCount: 1 }, observedAt: 0, bytes: 15 * mb },
    upserts: [
      { id: 'a', version: 'v1', projection: runListProjection(run('a', 1)), bytes: 15 * mb },
    ],
    deletes: [],
  });
  for (const project of ['p1', 'p2'])
    await store.putQuery({
      id: resourceQuery(Methods.RUN_LIST, { project }).id,
      data: { runs: [], totalCount: 0 },
      observedAt: 1,
      bytes: 11 * mb,
    });
  const cache = createGatewayResourceCache({ transport: fake.transport, store });
  const view = observe<RunListResult>(cache, { project: 'farm' });
  await flush();
  const listed = (await store.listQueries()).map(({ id }) => id);
  assert.ok(listed.includes(RUN_LIST_COLLECTION_ID));
  assert.ok(!listed.includes(resourceQuery(Methods.RUN_LIST, { project: 'p1' }).id));
  assert.ok(listed.includes(resourceQuery(Methods.RUN_LIST, { project: 'p2' }).id));
  assert.equal((await store.getRows!(RUN_LIST_COLLECTION_ID)).rows.length, 1);
  view.stop();
  await cache.dispose();
});

test('a refused versions read evicts the stored run collection', async () => {
  const fake = gateway([run('a', 1)]);
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport: fake.transport, store });
  const history = observe<RunListResult>(cache, { limit: 1000 });
  await flush();
  assert.equal((await store.getRows!(RUN_LIST_COLLECTION_ID)).rows.length, 1);
  fake.refuse('AUTH_FORBIDDEN');
  fake.changed();
  await flush();
  const stored = await store.getRows!(RUN_LIST_COLLECTION_ID);
  assert.equal(stored.entry, undefined);
  assert.equal(stored.rows.length, 0);
  assert.equal(cache.runListProjections?.(), undefined);
  assert.equal(history.last()?.status, 'error');
  history.stop();
  await cache.dispose();
});

test('without versionLists every run.list view reads in full, as before', async () => {
  const fake = gateway([run('a', 1), run('b', 2)], false);
  const store: ResourceStore = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport: fake.transport, store });
  const history = observe<RunListResult>(cache, { limit: 1000 });
  const active = observe<RunListResult>(cache, { active: true });
  await flush();
  fake.write(run('b', 2, { summary: 'changed' }));
  await flush();
  assert.deepEqual(reads(fake.calls), { versions: 0, ids: [], full: 4 });
  assert.equal((await store.getRows!(RUN_LIST_COLLECTION_ID)).entry, undefined);
  assert.equal(cache.runListProjections?.(), undefined);
  history.stop();
  active.stop();
  await cache.dispose();
});
