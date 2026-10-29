import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';

import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
  resourceQuery,
  type ResourceReadResult,
} from '../../src/client-cache/index.js';
import type {
  ResourceObserversReplaceParams,
  ResourceObserversReplaceResult,
  UpstreamObservation,
} from '../../src/rpc/resource-observers.js';
import type { ResourceChangedPayload } from '../../src/transport/events.js';

// Admission plumbing is tested before the owning server read is enabled for client cutover.
// Only the upstream key: farm-wide slot keys pace automatic rereads, which is tested elsewhere.
const prList = resourceQuery<{ value: string }>('pr.list');
const query = { ...prList, dependencies: prList.dependencies.slice(0, 1), live: true };
interface Admission {
  params: ResourceObserversReplaceParams;
  signal: AbortSignal;
  resolve(): void;
  reject(code: string): void;
}

class Transport implements ResourceCacheTransport {
  connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'none',
    scope: { gatewayUrl: 'ws://collector.invalid' },
    authority: { roles: [], workspaceAccess: 'farm' },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      resourceChanges: {
        version: 1,
        epoch: 'one',
        versionLists: false,
        upstreamObservers: { version: 1, methods: ['pr.list'] },
      },
    },
  };
  automatic = true;
  admissions: Admission[] = [];
  reads = 0;
  data: { value: string; observation?: UpstreamObservation } = {
    value: 'current',
    observation: { status: 'ready', observedAt: 1000 },
  };
  private connections = new Set<(state: ResourceCacheConnection) => void>();
  private changes = new Set<(payload: ResourceChangedPayload) => void>();
  getConnection = () => this.connection;
  onConnectionChange = (listener: (state: ResourceCacheConnection) => void) => {
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
  resynchronize() {
    this.set({ connected: false });
  }
  set(value: Partial<ResourceCacheConnection>) {
    this.connection = { ...this.connection, ...value };
    for (const listener of this.connections) listener(this.connection);
  }
  publish() {
    for (const listener of this.changes)
      listener({
        version: 1,
        epoch: 'one',
        changes: [{ key: query.dependencies[0]!, revision: this.reads, kind: 'updated' }],
      });
  }
  async request<T>(): Promise<ResourceReadResult<T>> {
    this.reads++;
    return {
      data: this.data as T,
      resourceState: {
        epoch: this.connection.capabilities!.resourceChanges!.epoch,
        dependencies: query.dependencies.map((key) => ({ key, revision: this.reads })),
      },
    };
  }
  replaceObservers(
    params: ResourceObserversReplaceParams,
    signal: AbortSignal,
  ): Promise<ResourceObserversReplaceResult> {
    return new Promise((resolve, reject) => {
      const admission = {
        params,
        signal,
        resolve: () => resolve({ version: 1, sequence: params.sequence, applied: true }),
        reject: (code: string) => reject(Object.assign(new Error(code), { code })),
      };
      this.admissions.push(admission);
      if (this.automatic) admission.resolve();
    });
  }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 1500;
  while (!check()) {
    assert(performance.now() < deadline, 'Condition did not arrive');
    await turn();
  }
}

test('two observers share one admitted read and withdraw only after the last observer', async () => {
  const transport = new Transport();
  const cache = createGatewayResourceCache({ transport });
  const one = cache.observe(query, () => {});
  const two = cache.observe(
    { ...query, ...resourceQuery('pr.list', { force: false }), live: true },
    () => {},
  );
  try {
    await until(() => cache.read(query).status === 'ready');
    assert.equal(transport.admissions.length, 1);
    assert.equal(transport.reads, 1);
    one();
    await turn();
    assert.equal(transport.admissions.length, 1);
    transport.publish();
    await until(() => transport.reads === 2);
    assert.equal(
      transport.admissions.length,
      1,
      'Read/notification traffic does not renew interest',
    );
    two();
    await until(() => transport.admissions.length === 2);
    assert.deepEqual(transport.admissions[1]!.params.queries, []);
  } finally {
    one();
    two();
    await cache.dispose();
  }
});

test('a query cannot read before its current connection admits it', async () => {
  const transport = new Transport();
  transport.automatic = false;
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  try {
    await until(() => transport.admissions.length === 1);
    assert.equal(transport.reads, 0);
    transport.admissions[0]!.resolve();
    await until(() => cache.read(query).status === 'ready');
    assert.equal(transport.reads, 1);
  } finally {
    transport.set({ connected: false });
    stop();
    await cache.dispose();
  }
});

test('hiding and foregrounding replace sets on the same socket with increasing sequences', async () => {
  const transport = new Transport();
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  try {
    await until(() => cache.read(query).status === 'ready');
    transport.set({ foreground: false });
    await until(() => transport.admissions.length === 2);
    assert.deepEqual(transport.admissions[1]!.params.queries, []);
    assert.equal(cache.read(query).status, 'stale');
    const reads = transport.reads;
    transport.set({ foreground: true });
    await until(() => cache.read(query).status === 'ready');
    assert.equal(transport.reads, reads + 1);
    assert.equal(transport.admissions[2]!.params.sequence, 3);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('an old connection acknowledgement cannot admit a reconnected query', async () => {
  const transport = new Transport();
  transport.automatic = false;
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  try {
    await until(() => transport.admissions.length === 1);
    transport.set({ connected: false });
    transport.set({ connected: true, id: 2 });
    await until(() => transport.admissions.length === 2);
    assert(transport.admissions[0]!.signal.aborted);
    transport.admissions[0]!.resolve();
    await turn();
    assert.equal(transport.reads, 0);
    assert.equal(transport.admissions[1]!.params.sequence, 1);
    transport.admissions[1]!.resolve();
    await until(() => cache.read(query).status === 'ready');
  } finally {
    transport.set({ connected: false });
    stop();
    await cache.dispose();
  }
});

test('removal while admission is pending cannot start a read or restore interest', async () => {
  const transport = new Transport();
  transport.automatic = false;
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  try {
    await until(() => transport.admissions.length === 1);
    stop();
    transport.admissions[0]!.resolve();
    await until(() => transport.admissions.length === 2);
    assert.deepEqual(transport.admissions[1]!.params.queries, []);
    transport.admissions[1]!.resolve();
    await turn();
    assert.equal(transport.reads, 0);
  } finally {
    transport.set({ connected: false });
    await cache.dispose();
  }
});

test('missing capability remains unsupported with retained stale facts and no read fallback', async () => {
  const transport = new Transport();
  delete transport.connection.capabilities!.resourceChanges!.upstreamObservers;
  const store = createMemoryResourceStore();
  const data = { value: 'saved', observation: { status: 'ready', observedAt: 500 } };
  await store.putQuery({
    id: query.id,
    data,
    observedAt: 900,
    bytes: Buffer.byteLength(JSON.stringify(data)),
  });
  const cache = createGatewayResourceCache({ transport, store });
  const stop = cache.observe(query, () => {});
  try {
    await until(() => cache.read(query).status === 'unsupported');
    assert.equal(transport.reads, 0);
    assert.equal(transport.admissions.length, 0);
    assert.equal(cache.read(query).data?.value, 'saved');
    assert.equal(cache.read(query).sourceObservation?.observedAt, 500);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('a warm gateway failure reaches a cold client without blessing the old source value as current', async () => {
  const transport = new Transport();
  transport.data = {
    value: 'last good',
    observation: {
      status: 'stale',
      observedAt: 123,
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'source offline' },
    },
  };
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  const stop = cache.observe(query, () => {});
  try {
    await until(() => cache.read(query).error?.code === 'UPSTREAM_UNAVAILABLE');
    assert.equal(cache.read(query).status, 'stale');
    assert.equal(cache.read(query).data?.value, 'last good');
    assert.equal(cache.read(query).sourceObservation?.observedAt, 123);
    assert(cache.read(query).observedAt! > 123, 'Local read time remains separate');
    const before = transport.reads;
    await turn();
    assert.equal(transport.reads, before);
    transport.data = { value: 'repaired', observation: { status: 'ready', observedAt: 456 } };
    await cache.retry(query);
    assert.equal(cache.read(query).status, 'ready');
    assert.equal(cache.read(query).sourceObservation?.observedAt, 456);
    assert.equal(cache.read(query).error, undefined);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('a stamped upstream reply without source freshness cannot become ready', async () => {
  const transport = new Transport();
  transport.data = { value: 'unproven' };
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  try {
    await until(() => cache.read(query).error?.code === 'RESOURCE_SOURCE_STATE_MISSING');
    assert.equal(cache.read(query).data, undefined);
    assert.equal(cache.read(query).status, 'error');
  } finally {
    stop();
    await cache.dispose();
  }
});

test('a restarted gateway without an upstream success cannot replace retained client facts with empty defaults', async () => {
  const transport = new Transport();
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  const stop = cache.observe(query, () => {});
  try {
    await until(() => cache.read(query).status === 'ready');
    const observedAt = cache.read(query).observedAt;
    transport.set({ connected: false });
    transport.data = {
      value: 'empty default',
      observation: {
        status: 'error',
        error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The restarted source is offline' },
      },
    };
    transport.set({
      connected: true,
      id: 2,
      capabilities: {
        ...transport.connection.capabilities!,
        resourceChanges: {
          ...transport.connection.capabilities!.resourceChanges!,
          epoch: 'restarted',
        },
      },
    });
    await until(() => cache.read(query).error?.code === 'UPSTREAM_UNAVAILABLE');
    assert.equal(cache.read(query).status, 'stale');
    assert.equal(cache.read(query).data?.value, 'current');
    assert.equal(cache.read(query).sourceObservation?.observedAt, 1000);
    assert.equal(cache.read(query).observedAt, observedAt);
    assert.equal((await store.getQuery(query.id))?.observedAt, observedAt);
  } finally {
    stop();
    await cache.dispose();
  }
});

test('a falsely advertised missing admission method is unsupported without an automatic retry loop', async () => {
  const transport = new Transport();
  transport.automatic = false;
  const cache = createGatewayResourceCache({ transport });
  const stop = cache.observe(query, () => {});
  try {
    await until(() => transport.admissions.length === 1);
    transport.admissions[0]!.reject('METHOD_NOT_FOUND');
    await until(() => cache.read(query).status === 'unsupported');
    await turn();
    assert.equal(transport.reads, 0);
    assert.equal(transport.admissions.length, 1);
  } finally {
    stop();
    await cache.dispose();
  }
  assert.equal(
    transport.admissions.length,
    1,
    'Dispose must not retry a method that never existed',
  );
});

test('refused admission cannot block disposing the old owner or trigger another refused cleanup RPC', async () => {
  const transport = new Transport();
  transport.automatic = false;
  const store = createMemoryResourceStore();
  await store.putQuery({
    id: query.id,
    data: transport.data,
    observedAt: 1000,
    bytes: Buffer.byteLength(JSON.stringify(transport.data)),
  });
  const cache = createGatewayResourceCache({ transport, store });
  const stop = cache.observe(query, () => {});
  try {
    await until(() => transport.admissions.length === 1);
    transport.admissions[0]!.reject('AUTH_FORBIDDEN');
    await until(() => cache.read(query).error?.code === 'AUTH_FORBIDDEN');
    assert.equal(cache.read(query).data, undefined);
  } finally {
    stop();
    await turn();
    await cache.dispose('principal-change');
  }
  assert.equal(transport.admissions.length, 1);
  assert.equal(store.deleted, true);
  assert.equal(await store.getQuery(query.id), undefined);
});

test('disposing withdraws observers over a connected socket, and skips a closed one', async () => {
  for (const connected of [true, false]) {
    const transport = new Transport();
    const cache = createGatewayResourceCache({ transport });
    cache.observe(query, () => {});
    await until(() => cache.read(query).status === 'ready');
    assert.equal(transport.admissions.length, 1);
    // The owner disposes in the same turn the socket closes, before the cache hears of it.
    if (!connected) transport.connection = { ...transport.connection, connected: false };
    await cache.dispose();
    assert.deepEqual(
      transport.admissions.slice(1).map((admission) => admission.params.queries),
      connected ? [[]] : [],
    );
  }
});
