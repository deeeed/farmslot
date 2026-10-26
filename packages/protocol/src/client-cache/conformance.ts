import type { GatewayAuthConnectResult } from '../rpc/auth.js';
import type { RoleBinding } from '../rpc/principal.js';
import type { ResourceChangedPayload } from '../transport/events.js';

import { createGatewayResourceCache } from './cache.js';
import { gitBlobHash } from './content.js';
import { canonicalResourceJson, type ResourceReadStamp } from './keys.js';
import { type ResourceQuery, resourceQuery, type ResourceReadMethod } from './registry.js';
import type { ResourceStore, ResourceStoreMetadata, ResourceStoreScope } from './store.js';
import type {
  GatewayResourceCache,
  ResourceCacheConnection,
  ResourceCacheTransport,
  ResourceConnectionReason,
  ResourceQueryState,
  ResourceReadResult,
} from './types.js';

interface ConformanceData {
  value: string;
}
interface ConformanceRead {
  signal: AbortSignal;
  resolve(data: ConformanceData, revision?: number): void;
  reject(code: string): void;
}
type StoreFactory = (scope: ResourceStoreScope) => ResourceStore | Promise<ResourceStore>;
const roles: RoleBinding[] = [{ role: 'admin', scope: { kind: 'global' } }];
const capabilities: GatewayAuthConnectResult['capabilities'] = {
  httpBearerAuth: true,
  voiceInstructionFormatting: false,
  batchedContent: false,
  resourceChanges: { version: 1, epoch: 'conformance-epoch', versionLists: false },
};
const stamp = (revision = 0): ResourceReadStamp => ({
  epoch: 'conformance-epoch',
  dependencies: [{ key: { family: 'sources', scope: 'farm' }, revision }],
});

function verify(condition: unknown, message: string): void {
  if (!condition) throw new Error(`Resource store conformance: ${message}`);
}

function sameBytes(actual: Uint8Array | undefined, expected: ArrayLike<number>): boolean {
  return (
    actual !== undefined &&
    actual.byteLength === expected.length &&
    actual.every((byte, index) => byte === expected[index])
  );
}

/** Internal transport fixture also used by the portable cache's regression tests. */
export class ResourceCacheConformanceTransport implements ResourceCacheTransport {
  connection: ResourceCacheConnection;
  requestCount = 0;
  private readonly connections = new Set<
    (connection: ResourceCacheConnection, reason?: ResourceConnectionReason) => void
  >();
  private readonly changes = new Set<(payload: ResourceChangedPayload) => void>();
  private readonly reads: ConformanceRead[] = [];
  private readonly waiters: Array<(read: ConformanceRead) => void> = [];
  constructor(scope: ResourceStoreScope) {
    this.connection = {
      id: 0,
      connected: false,
      authMode: 'token',
      scope,
      authority: { roles, workspaceAccess: 'farm' },
      capabilities,
    };
  }
  getConnection = (): ResourceCacheConnection => this.connection;
  onConnectionChange = (
    listener: (connection: ResourceCacheConnection, reason?: ResourceConnectionReason) => void,
  ) => {
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
  setConnection(change: Partial<ResourceCacheConnection>, reason?: ResourceConnectionReason): void {
    this.connection = { ...this.connection, ...change };
    for (const listener of this.connections) listener(this.connection, reason);
  }
  advance(revision: number): void {
    this.publish({
      version: 1,
      epoch: 'conformance-epoch',
      changes: [{ key: { family: 'sources', scope: 'farm' }, revision, kind: 'updated' }],
    });
  }
  publish(payload: ResourceChangedPayload): void {
    for (const listener of this.changes) listener(payload);
  }
  resynchronize = (): void => this.setConnection({ connected: false }, 'network');
  request<T>(
    _method: ResourceReadMethod,
    _params: unknown,
    signal: AbortSignal,
  ): Promise<ResourceReadResult<T>> {
    this.requestCount++;
    return new Promise((resolve, reject) => {
      const read: ConformanceRead = {
        signal,
        resolve: (data, revision) => resolve({ data: data as T, resourceState: stamp(revision) }),
        reject: (code) => reject(Object.assign(new Error(code), { code })),
      };
      const waiter = this.waiters.shift();
      if (waiter) waiter(read);
      else this.reads.push(read);
    });
  }
  nextRead(): Promise<ConformanceRead> {
    const read = this.reads.shift();
    if (read) return Promise.resolve(read);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Conformance read did not start')), 2000);
      this.waiters.push((next) => {
        clearTimeout(timer);
        resolve(next);
      });
    });
  }
}

/** The query is registered; only this store-seam fixture enables persistence before migration. */
function persistedQuery(): ResourceQuery<ConformanceData> {
  return { ...resourceQuery<ConformanceData>('sources.status'), persisted: true };
}

async function storedState(
  cache: GatewayResourceCache,
  query: ResourceQuery<ConformanceData>,
): Promise<ResourceQueryState<ConformanceData>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Stored query did not hydrate')), 2000);
    cache.observe(query, (state) => {
      if (state.status === 'stale' && state.data) {
        clearTimeout(timer);
        resolve(state);
      }
    });
  });
}

/** Experimental, framework-free contract run by every ResourceStore adapter. */
export async function runResourceStoreConformance(factory: StoreFactory): Promise<string[]> {
  const passed: string[] = [];
  let counter = 0;
  const scope = (): ResourceStoreScope => ({
    gatewayUrl: 'ws://conformance.invalid/',
    profileId: `conformance-${++counter}`,
    principalId: 'principal-a',
    principalGeneration: 0,
  });
  const query = persistedQuery();

  async function fixture(initialRoles = roles) {
    const identity = scope();
    const store = await factory(identity);
    const metadata: ResourceStoreMetadata = {
      scope: identity,
      authority: { roles: initialRoles, workspaceAccess: 'farm' },
    };
    await store.setMetadata(metadata);
    await store.putQuery({ id: query.id, data: { value: 'stored' }, observedAt: 123, bytes: 18 });
    const transport = new ResourceCacheConformanceTransport(identity);
    transport.connection.authority = metadata.authority;
    const cache = createGatewayResourceCache({
      transport,
      store,
      openStore: (next) => Promise.resolve(factory(next.scope)),
    });
    return { identity, store, transport, cache };
  }

  {
    const store = await factory(scope());
    try {
      const original = { id: 'atomic', data: { value: 'before' }, observedAt: 1, bytes: 18 };
      await store.putQuery(original);
      original.data.value = 'mutated by caller';
      verify(
        (await store.getQuery<ConformanceData>('atomic'))?.data.value === 'before',
        'write must take an owned snapshot',
      );
      await store.putQuery({ id: 'atomic', data: { value: 'after' }, observedAt: 2, bytes: 17 });
      verify(
        (await store.listQueries()).length === 1 && (await store.byteTotals()).queries === 17,
        'replacement and byte totals must be atomic',
      );
      const copy = await store.getQuery<ConformanceData>('atomic');
      copy!.data.value = 'mutated read';
      verify(
        (await store.getQuery<ConformanceData>('atomic'))?.data.value === 'after',
        'read must not expose stored mutable state',
      );
      await store.deleteAll();
      await store.putQuery(original);
      verify(
        (await store.getQuery('atomic')) === undefined && (await store.byteTotals()).queries === 0,
        'deleted store must drop late reads and writes',
      );
      passed.push('atomic snapshots, byte totals and deleted-incarnation fencing');
    } finally {
      await store.close();
    }
  }

  {
    const store = await factory(scope());
    try {
      const key = { kind: 'blob' as const, id: 'conformance-blob' };
      const empty = { kind: 'artifact' as const, id: 'conformance-empty' };
      const data = new Uint8Array([0, 1, 2, 255]);
      await store.putContent({
        ...key,
        data,
        bytes: 4,
        origin: 'prefetch',
        cohort: 'run',
        accessedAt: 1,
      });
      await store.putContent({
        ...empty,
        data: new Uint8Array(),
        bytes: 0,
        origin: 'opened',
        cohort: 'gate',
        accessedAt: 2,
      });
      data[0] = 9;
      const saved = await store.getContent(key);
      verify(
        sameBytes(saved?.data, [0, 1, 2, 255]) &&
          saved?.origin === 'prefetch' &&
          saved.cohort === 'run' &&
          saved.accessedAt === 1,
        'content must round-trip an owned copy of binary bytes',
      );
      saved!.data[1] = 9;
      verify(
        sameBytes((await store.getContent(key))?.data, [0, 1, 2, 255]) &&
          sameBytes((await store.getContent(empty))?.data, []) &&
          (await store.getContent({ kind: 'diff', id: key.id })) === undefined,
        'content reads must be owned copies keyed by kind and id',
      );
      verify(
        (await store.hasContent(key)) && !(await store.hasContent({ kind: 'diff', id: key.id })),
        'presence must be keyed by kind and id',
      );
      await store.putContentAlias('frozen', key);
      const first = await store.getContentByAlias('frozen');
      await store.putContentAlias('frozen', empty);
      await store.putContentAlias('absent', { kind: 'blob', id: 'not-held' });
      verify(
        sameBytes(first?.data, [0, 1, 2, 255]) &&
          first?.id === key.id &&
          sameBytes((await store.getContentByAlias('frozen'))?.data, []) &&
          (await store.getContentByAlias('absent')) === undefined,
        'an alias must name held content, and the latest alias must win',
      );
      await store.touchContent(key, 5, 'opened');
      const touched = (await store.listContent()).find((row) => row.id === key.id);
      verify(
        touched?.accessedAt === 5 && touched.origin === 'opened' && !('data' in touched),
        'touch must change recency and origin, and listings must omit bytes',
      );
      await store.deleteContent(empty);
      verify(
        (await store.listContent()).length === 1 &&
          (await store.byteTotals()).content === 4 &&
          (await store.getContentByAlias('frozen')) === undefined,
        'content deletion, its aliases and byte totals must be exact',
      );
      await store.putContent({
        ...empty,
        data: new Uint8Array(),
        bytes: 0,
        origin: 'opened',
        cohort: 'gate',
        accessedAt: 2,
      });
      verify(
        (await store.getContentByAlias('frozen')) === undefined,
        'content stored again must not revive a deleted alias',
      );
      await store.deleteAll();
      await store.putContent({
        ...key,
        data,
        bytes: 4,
        origin: 'opened',
        cohort: 'gate',
        accessedAt: 6,
      });
      await store.putContentAlias('frozen', key);
      verify(
        (await store.getContent(key)) === undefined &&
          !(await store.hasContent(key)) &&
          (await store.getContentByAlias('frozen')) === undefined &&
          (await store.byteTotals()).content === 0,
        'deleted store must drop late content writes',
      );
      passed.push(
        'content bytes, presence, aliases, origin and recency, byte totals and deletion fencing',
      );
    } finally {
      await store.close();
    }
  }

  {
    const identity = scope();
    const store = await factory(identity);
    const transport = new ResourceCacheConformanceTransport(identity);
    transport.setConnection({ connected: true, id: 1 });
    const cache = createGatewayResourceCache({
      transport,
      store,
      openStore: (next) => Promise.resolve(factory(next.scope)),
    });
    try {
      const data = new TextEncoder().encode('verified file\n');
      const key = { kind: 'blob' as const, id: gitBlobHash(data) };
      const content = { key, data, origin: 'prefetch' as const, cohort: 'gate' as const };
      verify(
        !(await cache.storeContent({
          ...content,
          key: { ...key, id: gitBlobHash(new Uint8Array()) },
        })) && (await store.listContent()).length === 0,
        'mismatched bytes must be refused before storing',
      );
      verify(
        await cache.storeContent({ ...content, alias: 'frozen-diff:run:base:head' }),
        'verified bytes must be stored',
      );
      verify(
        (await cache.hasContent(key)) &&
          sameBytes(await cache.readContent(key), data) &&
          sameBytes(await cache.readContentByAlias('frozen-diff:run:base:head'), data) &&
          (await store.getContent(key))?.origin === 'prefetch',
        'presence and reads, by key or alias, must not mark content opened',
      );
      verify(
        sameBytes(await cache.openContentByAlias('frozen-diff:run:base:head'), data) &&
          (await store.getContent(key))?.origin === 'opened',
        'opening by alias must mark content opened',
      );
      const lateData = new TextEncoder().encode('late file\n');
      const late = cache.storeContent({
        ...content,
        key: { kind: 'blob', id: gitBlobHash(lateData) },
        data: lateData,
      });
      transport.setConnection(
        { connected: false, scope: { ...identity, principalId: 'principal-b' } },
        'principal-change',
      );
      verify(
        !(await late) &&
          !(await cache.hasContent(key)) &&
          (await cache.readContent(key)) === undefined &&
          (await cache.readContentByAlias('frozen-diff:run:base:head')) === undefined &&
          store.deleted,
        'a principal change must fence content reads and late writes',
      );
      passed.push('verified content storage, aliases, opened marking and owner fencing');
    } finally {
      await cache.dispose();
    }
  }

  {
    const { store, transport, cache } = await fixture();
    try {
      const state = await storedState(cache, query);
      verify(
        state.observedAt === 123 && transport.requestCount === 0,
        'offline stored data must retain its age and be stale',
      );
      transport.setConnection({ connected: true, id: 1 });
      const done = cache.retry(query);
      const read = await transport.nextRead();
      read.resolve({ value: 'current' });
      verify(
        (await done).status === 'ready' &&
          (await store.getQuery<ConformanceData>(query.id))?.data.value === 'current',
        'only a current-connection read can become ready',
      );
      transport.setConnection({ connected: false }, 'network');
      verify(
        cache.read(query).status === 'stale' &&
          cache.read(query).data?.value === 'current' &&
          !store.deleted,
        'network loss must preserve stored data',
      );
      transport.setConnection({ connected: true, id: 2 });
      const reconnect = cache.retry(query);
      (await transport.nextRead()).resolve({ value: 'reconnected' });
      verify(
        (await reconnect).status === 'ready' && transport.requestCount === 2,
        'same-epoch reconnect must refetch',
      );
      passed.push('stale hydration, observation age and same-epoch reconnect');
    } finally {
      await cache.dispose();
    }
  }

  {
    const { transport, cache } = await fixture();
    try {
      await storedState(cache, query);
      transport.setConnection({ connected: true, id: 1 });
      const secondObserver = cache.observe(query, () => {});
      const done = cache.retry(query);
      const first = await transport.nextRead();
      verify(transport.requestCount === 1, 'observers must share an in-flight read');
      transport.advance(1);
      transport.advance(2);
      first.resolve({ value: 'old' }, 0);
      verify((await done).status === 'stale', 'an invalidated response cannot become ready');
      const followup = await transport.nextRead();
      const refreshed = cache.retry(query);
      followup.resolve({ value: 'new' }, 2);
      verify(
        (await refreshed).data?.value === 'new' && cache.read(query).status === 'ready',
        'coalesced writes must be covered before ready',
      );
      transport.advance(2);
      transport.advance(1);
      verify(
        cache.read(query).status === 'ready',
        'duplicate and out-of-order invalidations are harmless',
      );
      secondObserver();
      passed.push('request sharing and read/write races');
    } finally {
      await cache.dispose();
    }
  }

  for (const dimension of ['roles', 'workspaceAccess', 'principalGeneration'] as const) {
    const { store, transport, cache } = await fixture();
    try {
      await storedState(cache, query);
      const authority = {
        roles: dimension === 'roles' ? [] : roles,
        workspaceAccess: dimension === 'workspaceAccess' ? ('native' as const) : ('farm' as const),
      };
      transport.setConnection({
        connected: true,
        id: 1,
        authority,
        scope: {
          ...transport.connection.scope,
          ...(dimension === 'principalGeneration' ? { principalGeneration: 1 } : {}),
        },
      });
      const done = cache.retry(query);
      const read = await transport.nextRead();
      verify(
        store.deleted && cache.read(query).data === undefined,
        `${dimension} change must delete before applying a reply`,
      );
      read.resolve({ value: 'new authority' });
      await done;
      passed.push(`${dimension} scope deletion`);
    } finally {
      await cache.dispose();
    }
  }

  {
    const initialRoles: RoleBinding[] = [...roles, { role: 'operator', scope: { kind: 'global' } }];
    const { store, transport, cache } = await fixture(initialRoles);
    try {
      await storedState(cache, query);
      transport.setConnection({
        connected: true,
        id: 1,
        authority: { roles: [...initialRoles, ...initialRoles].reverse(), workspaceAccess: 'farm' },
      });
      const done = cache.retry(query);
      (await transport.nextRead()).resolve({ value: 'same set' });
      await done;
      verify(!store.deleted, 'roles are compared as a set');
      passed.push('role-set comparison');
    } finally {
      await cache.dispose();
    }
  }

  for (const reason of [
    'sign-out',
    'principal-change',
    'session-ended',
    'credential-refused',
  ] as const) {
    const { store, transport, cache } = await fixture();
    try {
      await storedState(cache, query);
      transport.setConnection({ connected: false }, reason);
      await cache.retry(query);
      verify(
        store.deleted && cache.read(query).data === undefined,
        `${reason} must delete the store`,
      );
      passed.push(`${reason} deletion`);
    } finally {
      await cache.dispose();
    }
  }
  for (const reason of ['network', 'access-token-expired', 'token-refresh'] as const) {
    const { store, transport, cache } = await fixture();
    try {
      await storedState(cache, query);
      transport.setConnection({ connected: false }, reason);
      await cache.retry(query);
      verify(
        !store.deleted && cache.read(query).data?.value === 'stored',
        `${reason} must preserve observations`,
      );
      passed.push(`${reason} preservation`);
    } finally {
      await cache.dispose();
    }
  }

  for (const code of ['AUTH_FORBIDDEN', 'NOT_FOUND', 'TIMEOUT'] as const) {
    const { store, transport, cache } = await fixture();
    try {
      await storedState(cache, query);
      transport.setConnection({ connected: true, id: 1 });
      const done = cache.retry(query);
      (await transport.nextRead()).reject(code);
      const state = await done;
      verify(state.error?.code === code, 'read failures must remain visible');
      const saved = await store.getQuery(query.id);
      verify(
        code === 'TIMEOUT'
          ? saved !== undefined && state.status === 'stale'
          : saved === undefined && state.data === undefined,
        `${code} must ${code === 'TIMEOUT' ? 'preserve stale data' : 'evict the observation'}`,
      );
      verify(transport.requestCount === 1, 'a failed read must not enter an automatic retry loop');
      passed.push(`${code} read failure`);
    } finally {
      await cache.dispose();
    }
  }

  {
    const { transport, cache } = await fixture();
    await storedState(cache, query);
    transport.setConnection({ connected: true, id: 1 });
    const done = cache.retry(query);
    const read = await transport.nextRead();
    await cache.dispose();
    verify(read.signal.aborted, 'dispose must cancel owned requests');
    read.resolve({ value: 'late response' });
    await done;
    passed.push('late-response fencing after disposal');
  }
  verify(canonicalResourceJson(passed).length > 0, 'conformance must execute checks');
  return passed;
}
