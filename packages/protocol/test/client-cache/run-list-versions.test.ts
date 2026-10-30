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
import {
  RUN_LIST_UNLIMITED,
  runListPage,
  runListProjection,
} from '../../src/runs/run-list-filter.js';
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
  let failPage = false;
  let deferred: { kind: 'versions' | 'ids'; gate: Promise<void> } | undefined;
  const release = async (kind: 'versions' | 'ids') => {
    if (deferred?.kind !== kind) return;
    const { gate } = deferred;
    deferred = undefined;
    await gate;
  };
  const changeListeners = new Set<(payload: ResourceChangedPayload) => void>();
  const connectionListeners = new Set<(connection: ResourceCacheConnection) => void>();
  let connection: ResourceCacheConnection = {
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
    onConnectionChange(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
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
        const reply = { data: result as T, resourceState: stamp() };
        await release('versions');
        return reply;
      }
      if (value.ids) {
        if (failPage) {
          failPage = false;
          throw Object.assign(new Error('Socket closed'), { code: 'TRANSPORT_CLOSED' });
        }
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
        const reply = { data: result as T, resourceState: stamp() };
        await release('ids');
        return reply;
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
    failNextPage: () => (failPage = true),
    /** Holds the next `kind` reply, as the gateway answered it then, until the returned release. */
    defer(kind: 'versions' | 'ids') {
      let open!: () => void;
      deferred = { kind, gate: new Promise<void>((resolve) => (open = resolve)) };
      return () => open();
    },
    /** A dropped or restored socket on the same gateway epoch. */
    setConnected(connected: boolean) {
      connection = { ...connection, id: ++counter, connected };
      for (const listener of connectionListeners) listener(connection);
    },
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

test('a reconnect reads versions before held rows are ready again', async () => {
  const fake = gateway([run('a', 1), run('b', 2)]);
  const cache = createGatewayResourceCache({
    transport: fake.transport,
    store: createMemoryResourceStore(),
  });
  const seen: Array<{ status: string; versionReads: number; runs?: string[] }> = [];
  const stop = cache.observe(
    resourceQuery<RunListResult>(Methods.RUN_LIST, { limit: 1000 }),
    (state) =>
      seen.push({
        status: state.status,
        versionReads: reads(fake.calls).versions,
        runs: ids(state),
      }),
  );
  await flush();
  assert.equal(seen[seen.length - 1].status, 'ready');
  fake.setConnected(false);
  await flush();
  // Changes while the socket is down: their notifications reach no one.
  fake.remove('b');
  fake.write(run('c', 3));
  seen.length = 0;
  fake.setConnected(true);
  await flush();
  assert.equal(reads(fake.calls).versions, 2);
  assert.ok(seen.every(({ status, versionReads }) => status !== 'ready' || versionReads === 2));
  assert.deepEqual(seen[seen.length - 1], { status: 'ready', versionReads: 2, runs: ['c', 'a'] });
  stop();
  await cache.dispose();
});

test('a deletion survives a failed catch-up page until a merge stores it', async () => {
  const fake = gateway([run('a', 1), run('b', 2)]);
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport: fake.transport, store });
  const history = observe<RunListResult>(cache, { limit: 1000 });
  await flush();
  fake.failNextPage();
  fake.remove('b');
  fake.write(run('c', 3));
  await flush();
  assert.deepEqual((await store.getRows!(RUN_LIST_COLLECTION_ID)).rows.map(({ id }) => id).sort(), [
    'a',
    'b',
  ]);
  fake.changed();
  await flush();
  const saved = await store.getRows!(RUN_LIST_COLLECTION_ID);
  assert.deepEqual(saved.rows.map(({ id }) => id).sort(), ['a', 'c']);
  history.stop();
  await cache.dispose();

  const copy = createMemoryResourceStore();
  await copy.mergeRows!(RUN_LIST_COLLECTION_ID, {
    entry: saved.entry!,
    upserts: saved.rows,
    deletes: [],
  });
  const offline = gateway([]);
  const cold = createGatewayResourceCache({
    transport: {
      ...offline.transport,
      getConnection: () => ({ ...offline.transport.getConnection(), connected: false }),
    },
    store: copy,
  });
  const stored = observe<RunListResult>(cold, { limit: 1000 });
  await flush();
  assert.deepEqual(ids(stored.last()), ['c', 'a']);
  stored.stop();
  await cold.dispose();
});

test('a run listed again before its deletion is stored stays stored', async () => {
  const fake = gateway([run('a', 1), run('b', 2)]);
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport: fake.transport, store });
  const history = observe<RunListResult>(cache, { limit: 1000 });
  await flush();
  fake.failNextPage();
  fake.remove('b');
  fake.write(run('c', 3));
  await flush();
  // b's deletion waits for the next merge, and b is listed again before it.
  fake.write(run('b', 2, { summary: 'back' }));
  await flush();
  const saved = await store.getRows!(RUN_LIST_COLLECTION_ID);
  assert.deepEqual(saved.rows.map(({ id }) => id).sort(), ['a', 'b', 'c']);
  history.stop();
  await cache.dispose();

  const copy = createMemoryResourceStore();
  await copy.mergeRows!(RUN_LIST_COLLECTION_ID, {
    entry: saved.entry!,
    upserts: saved.rows,
    deletes: [],
  });
  const offline = gateway([]);
  const cold = createGatewayResourceCache({
    transport: {
      ...offline.transport,
      getConnection: () => ({ ...offline.transport.getConnection(), connected: false }),
    },
    store: copy,
  });
  const stored = observe<RunListResult>(cold, { limit: 1000 });
  await flush();
  assert.deepEqual(ids(stored.last()), ['c', 'b', 'a']);
  assert.equal(stored.last()?.data?.runs[1].summary, 'back');
  stored.stop();
  await cold.dispose();
});

test('a versions reply or page from before a reconnect never changes the collection', async () => {
  for (const kind of ['versions', 'ids'] as const) {
    const fake = gateway([run('a', 1), run('b', 2)]);
    const store = createMemoryResourceStore();
    const cache = createGatewayResourceCache({ transport: fake.transport, store });
    const history = observe<RunListResult>(cache, { limit: 1000 });
    await flush();
    const release = fake.defer(kind);
    fake.write(run('b', 2, { summary: 'old' }));
    await flush();
    fake.setConnected(false);
    await flush();
    fake.write(run('b', 2, { summary: 'new' }));
    fake.write(run('c', 3));
    fake.setConnected(true);
    await flush();
    // The old connection's reply, listing b as it was and no c, arrives last.
    release();
    await flush();
    assert.deepEqual(
      cache.runListProjections?.()?.map(({ id, summary }) => [id, summary]),
      [
        ['c', undefined],
        ['b', 'new'],
        ['a', undefined],
      ],
      kind,
    );
    const stored = await store.getRows!(RUN_LIST_COLLECTION_ID);
    assert.deepEqual(
      stored.rows.map(({ id, version }) => [id, version]).sort(),
      ['a', 'b', 'c'].map((id) => [id, fake.versionsOf(id)]),
      kind,
    );
    assert.equal(history.last()?.status, 'ready', kind);
    assert.deepEqual(ids(history.last()), ['c', 'b', 'a'], kind);
    history.stop();
    await cache.dispose();
  }
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

test('a live view carries the run collection observation time, as a cold start does', async (t) => {
  // Every clock read differs, so a view stamped on its own would not match its collection.
  let clock = 1_000;
  t.mock.method(Date, 'now', () => ++clock);
  const fake = gateway([run('a', 1), run('b', 2)]);
  const store = createMemoryResourceStore();
  const live = createGatewayResourceCache({ transport: fake.transport, store });
  const history = observe<RunListResult>(live, { limit: 1000 });
  const tagged = observe<RunListResult>(live, { familyId: 'family-b' });
  await flush();
  const saved = await store.getRows!(RUN_LIST_COLLECTION_ID);
  assert.equal(history.last()?.status, 'ready');
  assert.equal(history.last()?.observedAt, saved.entry?.observedAt);
  assert.equal(tagged.last()?.observedAt, saved.entry?.observedAt);
  history.stop();
  tagged.stop();
  await live.dispose();

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
  const restored = observe<RunListResult>(cold, { familyId: 'family-b' });
  await flush();
  assert.equal(restored.last()?.status, 'stale');
  assert.equal(restored.last()?.observedAt, saved.entry?.observedAt);
  restored.stop();
  await cold.dispose();
});

test('Command Center history hydrates cold offline with its summaries', async () => {
  // apps/command-center/ui/src/state.ts `runHistoryQuery`.
  const runHistoryParams = {
    limit: 1000,
    includeFamilySummaries: true,
    includeProjectAnalytics: true,
  };
  const fake = gateway([run('a', 1), run('b', 2)]);
  const store = createMemoryResourceStore();
  const first = createGatewayResourceCache({ transport: fake.transport, store });
  const filled = observe<RunListResult>(first, runHistoryParams);
  await flush();
  assert.equal(filled.last()?.status, 'ready');
  const saved = await store.getRows!(RUN_LIST_COLLECTION_ID);
  filled.stop();
  await first.dispose();

  const copy = createMemoryResourceStore();
  await copy.mergeRows!(RUN_LIST_COLLECTION_ID, {
    entry: saved.entry!,
    upserts: saved.rows,
    deletes: [],
  });
  const offline = gateway([]);
  const cold = createGatewayResourceCache({
    transport: {
      ...offline.transport,
      getConnection: () => ({ ...offline.transport.getConnection(), connected: false }),
    },
    store: copy,
  });
  const history = observe<RunListResult>(cold, runHistoryParams);
  await flush();
  assert.equal(history.last()?.status, 'stale');
  assert.deepEqual(ids(history.last()), ['b', 'a']);
  assert.deepEqual(history.last()?.data?.summaryMeta, summaries.summaryMeta);
  assert.deepEqual(history.last()?.data?.familySummaries, []);
  assert.deepEqual(history.last()?.data?.projectAnalytics, []);
  history.stop();
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

test('an unlimited history view lists every run past the open-ended 500', async () => {
  const fake = gateway(Array.from({ length: 501 }, (_, index) => run(`r${index}`, 1)));
  const cache = createGatewayResourceCache({
    transport: fake.transport,
    store: createMemoryResourceStore(),
  });
  const history = observe<RunListResult>(cache, { sort: 'newest', limit: RUN_LIST_UNLIMITED });
  await flush();
  assert.equal(history.last()?.status, 'ready');
  assert.equal(history.last()?.data?.runs.length, 501);
  assert.equal(history.last()?.data?.totalCount, 501);
  history.stop();
  await cache.dispose();
});
