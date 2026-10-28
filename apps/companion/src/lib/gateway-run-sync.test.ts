import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FleetStatus,
  GatewayAuthConnectResult,
  ResourceChangedPayload,
  Run,
} from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type GatewayResourceCache,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
  resourceDependenciesForRead,
  type ResourceQuery,
  type ResourceQueryState,
  type ResourceReadMethod,
  type ResourceReadResult,
} from '@farmslot/protocol/client-cache';

import {
  HISTORY_RUN_LIST_LIMIT,
  nativeCollectionReadTimeout,
  NativeRunCollections,
  type NativeRunCollectionSnapshot,
  nativeRunHistoryQuery,
  nativeRunListVersionLists,
  nativeVersionedRunHistoryQuery,
} from './gateway-run-sync';

function run(id: string, status: Run['status'] = 'done'): Run {
  return {
    id,
    familyId: id,
    parentRunId: null,
    familyRootTicketOrPr: id,
    lane: 'production',
    variant: null,
    project: 'farm',
    flowType: 'dev',
    mode: 'interactive',
    ticketOrPr: id,
    status,
    slotId: null,
    taskFile: null,
    branch: null,
    steps: [],
    decisions: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    metrics: { runner: null, model: null, nudgeCount: 0 },
  };
}

class CollectionTransport implements ResourceCacheTransport {
  connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: {
      gatewayUrl: 'ws://collections.invalid/',
      principalId: 'owner',
      principalGeneration: 0,
    },
    authority: { roles: [], workspaceAccess: 'farm' },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      resourceChanges: { version: 1, epoch: 'collections', versionLists: false, observedReads: 1 },
    },
  };
  revision = 0;
  active = [run('active', 'monitoring')];
  history = [run('history')];
  fleet = {
    checkedAt: '2026-10-20T00:00:00Z',
    slots: [{ slot: 'fleet-slot' }],
    summary: {},
  } as FleetStatus;
  readonly reads: Array<{ method: ResourceReadMethod; params: unknown }> = [];
  readonly connections = new Set<(connection: ResourceCacheConnection) => void>();
  readonly changes = new Set<(payload: ResourceChangedPayload) => void>();
  getConnection = () => this.connection;
  onConnectionChange = (listener: (connection: ResourceCacheConnection) => void) => {
    this.connections.add(listener);
    return () => {
      this.connections.delete(listener);
    };
  };
  onResourceChanged = (listener: (payload: ResourceChangedPayload) => void) => {
    this.changes.add(listener);
    return () => {
      this.changes.delete(listener);
    };
  };
  resynchronize = () => this.disconnect();
  request<T>(method: ResourceReadMethod, params: unknown): Promise<ResourceReadResult<T>> {
    this.reads.push({ method, params });
    const data =
      method === 'fleet.status'
        ? { fleet: this.fleet }
        : method === 'decision.list'
          ? { decisions: [] }
          : {
              runs: Reflect.get(params as object, 'active') ? this.active : this.history,
              totalCount: 1,
            };
    return Promise.resolve({
      data: data as T,
      resourceState: {
        epoch: 'collections',
        dependencies: resourceDependenciesForRead(method, params)!.map((key) => ({
          key,
          revision: this.revision,
        })),
      },
    });
  }
  invalidateRuns() {
    this.revision++;
    for (const listener of this.changes)
      listener({
        version: 1,
        epoch: 'collections',
        changes: [
          { key: { family: 'runs', scope: 'farm' }, revision: this.revision, kind: 'updated' },
        ],
      });
  }
  disconnect() {
    this.connection = { ...this.connection, connected: false };
    for (const listener of this.connections) listener(this.connection);
  }
}

test('native collections keep history on demand, replace deleted rows, retain stale observations and clear on owner change', async () => {
  const transport = new CollectionTransport();
  const cache = createGatewayResourceCache({ transport, store: createMemoryResourceStore() });
  const observed: NativeRunCollectionSnapshot[] = [];
  const collections = new NativeRunCollections((snapshot) => observed.push(snapshot));
  const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  try {
    collections.bind(cache, 'first-owner');
    await flush();
    assert.equal(transport.reads.length, 3);
    assert.equal(observed.at(-1)?.fleet.status, 'ready');
    assert.equal(observed.at(-1)?.fleet.data?.fleet.slots[0].slot, 'fleet-slot');
    assert.deepEqual(
      observed.at(-1)?.runs.data?.runs.map(({ id }) => id),
      ['active'],
    );
    await collections.openHistory();
    await flush();
    assert.equal(transport.reads.length, 4);
    assert.deepEqual(nativeRunHistoryQuery.params, { limit: 80, sort: 'newest' });
    assert.equal(observed.at(-1)?.runs.data?.runs.length, 2);
    transport.active = [];
    transport.history = [];
    transport.invalidateRuns();
    await flush();
    assert.equal(transport.reads.length, 6, 'Each observed run query refreshes once');
    assert.deepEqual(
      observed.at(-1)?.runs.data?.runs,
      [],
      'No private ever-growing union survives deletion',
    );
    transport.disconnect();
    await flush();
    assert.equal(observed.at(-1)?.runs.status, 'stale');
    assert.equal(observed.at(-1)?.fleet.status, 'stale');
    assert.equal(observed.at(-1)?.fleet.data?.fleet.slots[0].slot, 'fleet-slot');
    assert(observed.at(-1)?.runs.observedAt !== undefined);
    collections.bind(undefined, 'second-owner');
    assert.equal(observed.at(-1)?.runs.data, undefined);
    assert.equal(observed.at(-1)?.decisions.data, undefined);
    assert.equal(observed.at(-1)?.history, undefined);
    assert.equal(observed.at(-1)?.fleet.data, undefined);
    collections.dispose();
  } finally {
    collections.dispose();
    await cache.dispose();
  }
});

test('a history request before owner hydration stays requested and native read deadlines stay bounded', async () => {
  const observed: NativeRunCollectionSnapshot[] = [];
  const transport = new CollectionTransport();
  const cache = createGatewayResourceCache({ transport });
  const collections = new NativeRunCollections((snapshot) => observed.push(snapshot));
  try {
    await collections.openHistory();
    collections.bind(cache, 'hydrated-owner');
    assert(observed.at(-1)?.history);
    assert.equal(nativeCollectionReadTimeout('run.list', { active: true }), 20_000);
    assert.equal(nativeCollectionReadTimeout('run.list', { limit: 80 }), 60_000);
    assert.equal(nativeCollectionReadTimeout('decision.list', {}), 30_000);
    assert.equal(nativeCollectionReadTimeout('run.get', {}), undefined);
  } finally {
    collections.dispose();
    await cache.dispose();
  }
});

/** A cache that records each observed query and answers reads from what the test stores. */
function recordingCache() {
  const observing = new Map<string, number>();
  const states = new Map<string, ResourceQueryState<unknown>>();
  const cache = {
    observe(query: ResourceQuery<unknown>) {
      observing.set(query.id, (observing.get(query.id) ?? 0) + 1);
      return () => observing.set(query.id, (observing.get(query.id) ?? 1) - 1);
    },
    read(query: ResourceQuery<unknown>) {
      return states.get(query.id) ?? { status: 'loading' };
    },
  } as unknown as GatewayResourceCache;
  const observed = (query: ResourceQuery<unknown>) => (observing.get(query.id) ?? 0) > 0;
  return { cache, states, observed };
}

test('a gateway with version lists observes the whole history; an older one keeps the 80-row read', async () => {
  assert.deepEqual(nativeVersionedRunHistoryQuery.params, { sort: 'newest' });
  assert.deepEqual(nativeRunHistoryQuery.params, { limit: HISTORY_RUN_LIST_LIMIT, sort: 'newest' });
  const { cache, observed } = recordingCache();
  const collections = new NativeRunCollections(() => {});
  try {
    collections.bind(cache, 'owner', true);
    await collections.openHistory();
    assert.equal(observed(nativeVersionedRunHistoryQuery), true);
    assert.equal(observed(nativeRunHistoryQuery), false);
    assert.equal(collections.historyLimit(), null, 'no row cap with version lists');

    collections.bind(cache, 'owner', false);
    assert.equal(observed(nativeVersionedRunHistoryQuery), false);
    assert.equal(observed(nativeRunHistoryQuery), true);
    assert.equal(collections.historyLimit(), HISTORY_RUN_LIST_LIMIT);
  } finally {
    collections.dispose();
  }
});

test('offline with the capability unknown, history shows the stored whole collection, else the 80 rows', async () => {
  const { cache, states, observed } = recordingCache();
  const shown: NativeRunCollectionSnapshot[] = [];
  const collections = new NativeRunCollections((snapshot) => shown.push(snapshot));
  try {
    collections.bind(cache, 'owner', null);
    await collections.openHistory();
    assert.equal(observed(nativeVersionedRunHistoryQuery), true);
    assert.equal(observed(nativeRunHistoryQuery), true);
    const limited = { status: 'stale', data: { runs: [run('limited')], totalCount: 1 } } as const;
    states.set(nativeRunHistoryQuery.id, limited);
    assert.equal(collections.historyObservation(), limited, 'a store from an older gateway');
    const whole = { status: 'stale', data: { runs: [run('a'), run('b')], totalCount: 2 } } as const;
    states.set(nativeVersionedRunHistoryQuery.id, whole);
    assert.equal(collections.historyObservation(), whole, 'the whole collection comes first');
    collections.bind(cache, 'owner', true);
    assert.equal(observed(nativeRunHistoryQuery), false, 'authentication settles the variant');
    assert.equal(shown.at(-1)?.history, whole);
  } finally {
    collections.dispose();
  }
  const capabilities = (versionLists?: boolean): GatewayAuthConnectResult['capabilities'] => ({
    httpBearerAuth: true,
    voiceInstructionFormatting: false,
    ...(versionLists === undefined
      ? {}
      : { resourceChanges: { version: 1, epoch: 'e', versionLists } }),
  });
  assert.equal(nativeRunListVersionLists(capabilities(true), false), true);
  assert.equal(nativeRunListVersionLists(capabilities(false), true), false);
  assert.equal(nativeRunListVersionLists(capabilities(), true), false, 'a gateway before ADR-071');
  assert.equal(nativeRunListVersionLists(undefined, true), false);
  assert.equal(nativeRunListVersionLists(undefined, false), null, 'offline before authentication');
});

test('a version read and each catch-up page get the full request deadline', () => {
  assert.equal(nativeCollectionReadTimeout('run.list', { versions: true }), 60_000);
  assert.equal(nativeCollectionReadTimeout('run.list', { ids: ['a', 'b'] }), 60_000);
  assert.equal(nativeCollectionReadTimeout('run.list', { active: true, ids: ['a'] }), 60_000);
  assert.equal(nativeCollectionReadTimeout('run.list', { active: true }), 20_000);
  assert.equal(nativeCollectionReadTimeout('run.list', undefined), 60_000);
});
