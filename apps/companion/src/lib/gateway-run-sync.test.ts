import assert from 'node:assert/strict';
import test from 'node:test';

import type { FleetStatus, ResourceChangedPayload, Run } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
  resourceDependenciesForRead,
  type ResourceReadMethod,
  type ResourceReadResult,
} from '@farmslot/protocol/client-cache';

import {
  nativeCollectionReadTimeout,
  NativeRunCollections,
  type NativeRunCollectionSnapshot,
  nativeRunHistoryQuery,
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
