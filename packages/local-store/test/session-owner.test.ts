import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';

import {
  createMemoryResourceStore,
  type ResourceClientConnection,
  type ResourceConnectionInputs,
  resourceQuery,
  type ResourceQueryState,
  type ResourceStoreIdentity,
  resourceStoreScopeId,
} from '@farmslot/protocol/client-cache';
import type { GatewayAuthConnectResult } from '@farmslot/protocol/rpc/auth';

import { ResourceCacheOwner } from '../src/owner.js';
import { createStoredResourceCache } from '../src/session.js';
import {
  createSqliteResourceStore,
  type ResourceSqliteDatabase,
  type SqliteValue,
} from '../src/sqlite-store.js';

const url = 'ws://session.invalid/';
const scope = { gatewayUrl: url, principalId: 'old', principalGeneration: 0 };
const authority = { roles: [], workspaceAccess: 'farm' as const };
const saved: ResourceStoreIdentity = { authMode: 'token', metadata: { scope, authority } };
const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };

test('owner visibility changes reach collector admission without a socket event or a cache replacement', async () => {
  const source = fixture();
  const authentication = auth('old');
  authentication.capabilities!.resourceChanges!.upstreamObservers = {
    version: 1,
    methods: ['pr.list'],
  };
  const sets: unknown[][] = [];
  source.client.replaceResourceObservers = async (params) => {
    sets.push(params.queries);
    return { version: 1, sequence: params.sequence, applied: true };
  };
  const owner = new ResourceCacheOwner({
    identities: () => ({ load: async () => null, save: async () => {} }),
    openStore: async () => createMemoryResourceStore(),
    onNotice() {},
    onError(error) {
      throw error;
    },
  });
  const connection = { id: 1, gatewayUrl: url, connected: true, foreground: true, authentication };
  owner.update({ client: source.client, connection });
  const cache = owner.cache!;
  // Exercise owner/session forwarding with the existing stamped fixture, before PR read cutover.
  const collectorQuery = {
    ...resourceQuery('pr.list'),
    live: true,
    sourceObservation: undefined,
    dependencies: query.dependencies,
  };
  const stop = cache.observe(collectorQuery, () => {});
  const until = async (check: () => boolean) => {
    const deadline = performance.now() + 1500;
    while (!check()) {
      assert(performance.now() < deadline);
      await turn();
    }
  };
  try {
    await until(() => cache.read(collectorQuery).status === 'ready');
    assert.equal(sets.length, 1);
    owner.update({ client: source.client, connection: { ...connection, foreground: false } });
    await until(() => sets.length === 2);
    assert.deepEqual(sets[1], []);
    assert.equal(owner.cache, cache);
    assert.equal(cache.read(collectorQuery).status, 'stale');
    owner.update({ client: source.client, connection });
    await until(() => sets.length === 3 && cache.read(collectorQuery).status === 'ready');
    assert.equal(owner.cache, cache);
  } finally {
    stop();
    await owner.dispose();
  }
});

function auth(principalId: string): GatewayAuthConnectResult {
  return {
    ok: true,
    clientKind: 'ui',
    authMode: 'token',
    authenticatedAt: 1,
    principal: {
      id: principalId,
      generation: 0,
      displayName: principalId,
      subjectKind: 'service',
      roles: [],
    },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      workspaceAccess: 'farm',
      resourceChanges: { version: 1, epoch: 'session-epoch', versionLists: false },
    },
  };
}

function fixture() {
  const listeners = new Set<() => void>();
  let reads = 0;
  const client: ResourceClientConnection = {
    async requestResource<T>() {
      reads++;
      return {
        data: { value: 'live' } as T,
        resourceState: {
          epoch: 'session-epoch',
          dependencies: [{ key: { family: 'sources', scope: 'farm' }, revision: 0 }],
        },
      };
    },
    subscribe: () => () => {},
    onConnectionChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reconnect() {},
  };
  return {
    client,
    emit() {
      for (const listener of listeners) listener();
    },
    get reads() {
      return reads;
    },
  };
}

test(
  'a legacy non-persistable connection keeps its memory observation on transport loss',
  { timeout: 2000 },
  async () => {
    const source = fixture();
    const authentication = auth('old');
    delete authentication.principal!.generation;
    let input: ResourceConnectionInputs = {
      id: 1,
      connected: true,
      gatewayUrl: url,
      authentication,
    };
    const cache = createStoredResourceCache({
      client: source.client,
      snapshot: () => input,
      identities: { load: async () => null, save: async () => {} },
      openStore: async () => {
        assert.fail('A missing generation must never open persistent storage');
      },
    });
    const stop = cache.observe(query, () => {});
    try {
      assert.equal((await cache.retry(query)).status, 'ready');
      input = { id: 2, connected: false, gatewayUrl: url };
      source.emit();
      assert.equal(cache.read(query).status, 'stale');
      assert.equal(cache.read(query).data?.value, 'live');
    } finally {
      stop();
      await cache.dispose();
    }
  },
);

test(
  'remembered render scope clears synchronously on revocation and follows live access',
  { timeout: 2000 },
  async () => {
    const source = fixture();
    const owner = new ResourceCacheOwner({
      identities: () => ({ load: async () => JSON.stringify(saved), save: async () => {} }),
      openStore: async () => createMemoryResourceStore(),
      onNotice() {},
      onError(error) {
        throw error;
      },
    });
    let input = { id: 0, connected: false, gatewayUrl: url } as ResourceConnectionInputs;
    const loaded = new Promise<void>((resolve) => {
      const stop = owner.subscribe(() => {
        if (owner.renderIdentity) {
          stop();
          resolve();
        }
      });
    });
    try {
      owner.update({ client: source.client, connection: input });
      await loaded;
      assert.equal(owner.renderIdentity?.metadata.authority.workspaceAccess, 'farm');
      assert.equal(source.reads, 0, 'Rendering saved scope must not authorize an RPC');
      const offlineKey = owner.renderKey;
      input = { id: 1, connected: true, gatewayUrl: url, authentication: auth('old') };
      owner.update({ client: source.client, connection: input });
      source.emit();
      assert.equal(
        owner.renderKey,
        offlineKey,
        'Verifying the same owner must preserve its rendered workspace',
      );
      const native = auth('old');
      native.capabilities.workspaceAccess = 'native';
      input = { id: 1, connected: true, gatewayUrl: url, authentication: native };
      owner.update({ client: source.client, connection: input });
      source.emit();
      assert.equal(owner.renderIdentity?.metadata.authority.workspaceAccess, 'native');
      assert.notEqual(owner.renderKey, offlineKey);
      owner.update({
        client: source.client,
        connection: { ...input, reason: 'credential-refused' },
      });
      assert.equal(owner.renderIdentity, undefined);
      assert.equal(owner.cache, undefined);
    } finally {
      await owner.dispose();
    }
  },
);

test(
  'a delayed identity load cannot reopen rendering after offline sign-out',
  { timeout: 2000 },
  async () => {
    const source = fixture();
    let release!: (value: string) => void;
    const load = new Promise<string>((resolve) => {
      release = resolve;
    });
    const owner = new ResourceCacheOwner({
      identities: () => ({ load: () => load, save: async () => {} }),
      openStore: async () => createMemoryResourceStore(),
      onNotice() {},
      onError(error) {
        throw error;
      },
    });
    const input = {
      client: source.client,
      connection: { id: 0, connected: false, gatewayUrl: url },
    };
    owner.update(input);
    owner.update({ ...input, signedOut: true });
    assert.equal(owner.renderIdentity, undefined);
    assert.equal(owner.renderKey, undefined);
    release(JSON.stringify(saved));
    await owner.dispose();
    assert.equal(owner.renderIdentity, undefined);
    assert.equal(owner.cache, undefined);
    assert.equal(source.reads, 0);
  },
);

test(
  'offline startup waits for remembered identity and hydrates stale data without a socket read',
  { timeout: 2000 },
  async () => {
    const source = fixture();
    const store = createMemoryResourceStore();
    await store.setMetadata(saved.metadata);
    await store.putQuery({ id: query.id, data: { value: 'stored' }, observedAt: 123, bytes: 18 });
    let release!: (raw: string) => void;
    const loaded = new Promise<string>((resolve) => {
      release = resolve;
    });

    for (const generation of [0, undefined]) {
      test(
        `render identity survives transport loss without granting live access, generation ${generation}`,
        { timeout: 2000 },
        async () => {
          const source = fixture();
          const owner = new ResourceCacheOwner({
            identities: () => ({ load: async () => null, save: async () => {} }),
            openStore: async () => createMemoryResourceStore(),
            onNotice() {},
            onError(error) {
              throw error;
            },
          });
          const original = auth('old');
          original.principal!.generation = generation;
          original.principal!.roles = [
            { role: 'admin', scope: { kind: 'global' } },
            { role: 'operator', scope: { kind: 'global' } },
          ];
          try {
            owner.update({
              client: source.client,
              connection: { id: 1, connected: true, gatewayUrl: url, authentication: original },
            });
            const key = owner.renderKey;
            assert(key);
            owner.update({
              client: source.client,
              connection: { id: 2, connected: false, gatewayUrl: url },
            });
            source.emit();
            assert.equal(owner.renderKey, key);
            assert.equal(owner.renderMetadata?.authority.workspaceAccess, 'farm');
            assert.equal(source.reads, 0);
            const equivalent = structuredClone(original);
            equivalent.principal!.roles = [...original.principal!.roles]
              .reverse()
              .concat(original.principal!.roles);
            owner.update({
              client: source.client,
              connection: { id: 3, connected: true, gatewayUrl: url, authentication: equivalent },
            });
            source.emit();
            assert.equal(
              owner.renderKey,
              key,
              'Role ordering and duplicates do not change authority',
            );
            const replacement = structuredClone(original);
            replacement.principal!.generation = 2;
            owner.update({
              client: source.client,
              connection: { id: 4, connected: true, gatewayUrl: url, authentication: replacement },
            });
            source.emit();
            assert.notEqual(owner.renderKey, key, 'A different generation remounts the workspace');
            owner.update({
              client: source.client,
              connection: { id: 4, connected: false, gatewayUrl: url },
              signedOut: true,
            });
            assert.equal(owner.renderKey, undefined);
          } finally {
            await owner.dispose();
          }
        },
      );
    }
    const cache = createStoredResourceCache({
      client: source.client,
      snapshot: () => ({ id: 0, connected: false, gatewayUrl: url }),
      identities: { load: () => loaded, save: async () => {} },
      openStore: async () => store,
    });
    let hydrated!: (state: ResourceQueryState<{ value: string }>) => void;
    const state = new Promise<ResourceQueryState<{ value: string }>>((resolve) => {
      hydrated = resolve;
    });
    cache.observe(query, (next) => {
      if (next.data) hydrated(next);
    });
    try {
      release(JSON.stringify(saved));
      assert.equal((await state).status, 'stale');
      assert.equal(cache.read(query).observedAt, 123);
      assert.equal(source.reads, 0);
    } finally {
      await cache.dispose();
    }
  },
);

test(
  'a changed live principal deletes the formerly selected store before the first read',
  { timeout: 2000 },
  async () => {
    const source = fixture();
    const old = createMemoryResourceStore();
    await old.setMetadata(saved.metadata);
    await old.putQuery({
      id: query.id,
      data: { value: 'old principal' },
      observedAt: 123,
      bytes: 18,
    });
    const stores = new Map([[resourceStoreScopeId(scope), old]]);
    const cache = createStoredResourceCache({
      client: source.client,
      snapshot: () => ({ id: 1, connected: true, gatewayUrl: url, authentication: auth('new') }),
      identities: { load: async () => JSON.stringify(saved), save: async () => {} },
      openStore: async (metadata) => {
        const key = resourceStoreScopeId(metadata.scope);
        const current = stores.get(key);
        if (current && !current.deleted) return current;
        const created = createMemoryResourceStore();
        stores.set(key, created);
        return created;
      },
    });
    try {
      assert.equal((await cache.retry(query)).status, 'ready');
      assert(old.deleted);
      assert.equal(cache.read(query).data?.value, 'live');
    } finally {
      await cache.dispose();
    }
  },
);

test(
  'removing the last profile disposes the cache without normalizing an empty URL',
  { timeout: 2000 },
  async () => {
    const source = fixture();
    const profiles: string[] = [];
    const owner = new ResourceCacheOwner({
      identities(gatewayUrl) {
        profiles.push(gatewayUrl);
        return { load: async () => null, save: async () => {} };
      },
      openStore: async () => createMemoryResourceStore(),
      onNotice() {},
      onError(error) {
        throw error;
      },
    });
    owner.update({
      client: source.client,
      connection: { id: 0, connected: false, gatewayUrl: url, profileId: 'one' },
    });
    assert(owner.cache);
    owner.update({
      client: source.client,
      connection: { id: 1, connected: false, gatewayUrl: '', profileId: '' },
    });
    assert.equal(owner.cache, undefined);
    assert.deepEqual(profiles, [url]);
    await owner.dispose();
  },
);

test(
  'a same-URL profile switch waits for the client binding to change',
  { timeout: 2000 },
  async () => {
    const source = fixture();
    const profiles: string[] = [];
    const owner = new ResourceCacheOwner({
      identities(_gatewayUrl, profileId) {
        profiles.push(profileId!);
        return { load: async () => null, save: async () => {} };
      },
      openStore: async () => createMemoryResourceStore(),
      onNotice() {},
      onError(error) {
        throw error;
      },
    });
    const original: ResourceConnectionInputs = {
      id: 1,
      connected: true,
      gatewayUrl: url,
      profileId: 'one',
      authentication: auth('old'),
    };
    try {
      owner.update({ client: source.client, connection: original });
      const previous = owner.cache;
      owner.update({ client: source.client, connection: { ...original, profileId: 'two' } });
      assert.equal(owner.cache, undefined);
      assert.deepEqual(profiles, ['one']);
      owner.update({
        client: source.client,
        connection: { id: 2, connected: false, gatewayUrl: url, profileId: 'two' },
      });
      assert(owner.cache && owner.cache !== previous);
      assert.deepEqual(profiles, ['one', 'two']);
    } finally {
      await owner.dispose();
    }
  },
);

test(
  'a failed sign-out retirement does not keep the next principal off persistent storage',
  { timeout: 2000 },
  async () => {
    const source = fixture();
    const admin = auth('admin');
    admin.capabilities!.resourceChanges!.upstreamObservers = { version: 1, methods: ['pr.list'] };
    let socketOpen = true;
    source.client.replaceResourceObservers = async (params) => {
      if (!socketOpen) throw new Error('Not connected');
      return { version: 1, sequence: params.sequence, applied: true };
    };
    const opened: string[] = [];
    const notices: (string | undefined)[] = [];
    const errors: string[] = [];
    const owner = new ResourceCacheOwner({
      identities: () => ({ load: async () => null, save: async () => {} }),
      async openStore(metadata) {
        opened.push(metadata.scope.principalId!);
        const memory = createMemoryResourceStore();
        return {
          ...memory,
          persistent: true,
          get deleted() {
            return memory.deleted;
          },
        };
      },
      onNotice: (notice) => notices.push(notice),
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    });
    const connection = { id: 1, gatewayUrl: url, connected: true, authentication: admin };
    owner.update({ client: source.client, connection });
    const collectorQuery = {
      ...resourceQuery('pr.list'),
      live: true,
      sourceObservation: undefined,
      dependencies: query.dependencies,
    };
    const stop = owner.cache!.observe(collectorQuery, () => {});
    try {
      assert.equal((await owner.cache!.retry(collectorQuery)).status, 'ready');
      // The owner retires the admin cache before that cache hears the socket close.
      socketOpen = false;
      owner.update({
        client: source.client,
        connection: { id: 1, gatewayUrl: url, connected: false },
        signedOut: true,
      });
      stop();
      owner.update({
        client: source.client,
        connection: { id: 2, gatewayUrl: url, connected: true, authentication: auth('operator') },
      });
      assert.equal((await owner.cache!.retry(query)).status, 'ready');
      assert.deepEqual(opened, ['admin', 'operator']);
      assert.deepEqual(errors, ['Not connected']);
      assert.equal(notices.at(-1), undefined);
    } finally {
      await owner.dispose();
    }
  },
);

test(
  'a sign-out whose deletion failed never lets the next owner of that scope hydrate its rows',
  { timeout: 2000 },
  async () => {
    const source = fixture();
    const sqlite = new DatabaseSync(':memory:');
    let failDeletion = false;
    const database: ResourceSqliteDatabase = {
      async run(sql, params = []) {
        if (failDeletion && sql.startsWith('DELETE FROM resource_stores')) {
          failDeletion = false;
          throw new Error('disk failed');
        }
        sqlite.prepare(sql).run(...params);
      },
      async all<T>(sql: string, params: readonly SqliteValue[] = []) {
        return sqlite.prepare(sql).all(...params) as T[];
      },
    };
    const errors: string[] = [];
    const owner = new ResourceCacheOwner({
      identities: () => ({ load: async () => null, save: async () => {} }),
      openStore: (metadata) => createSqliteResourceStore({ database, scope: metadata.scope }),
      onNotice() {},
      onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    });
    const connection = (id: number) => ({
      id,
      gatewayUrl: url,
      connected: true,
      authentication: auth('old'),
    });
    const live = source.client.requestResource;
    try {
      source.client.requestResource = async <T>() => ({
        data: { value: 'previous owner' } as T,
        resourceState: {
          epoch: 'session-epoch',
          dependencies: [{ key: { family: 'sources', scope: 'farm' }, revision: 0 }],
        },
      });
      owner.update({ client: source.client, connection: connection(1) });
      assert.equal((await owner.cache!.retry(query)).data?.value, 'previous owner');
      source.client.requestResource = live;
      failDeletion = true;
      owner.update({
        client: source.client,
        connection: { id: 1, gatewayUrl: url, connected: false },
        signedOut: true,
      });
      owner.update({ client: source.client, connection: connection(2) });
      const seen: (string | undefined)[] = [];
      const stop = owner.cache!.observe(query, (state) => seen.push(state.data?.value));
      assert.equal((await owner.cache!.retry(query)).data?.value, 'live');
      stop();
      assert.deepEqual(errors, ['disk failed']);
      assert(
        !seen.includes('previous owner'),
        'rows whose deletion was requested must never hydrate',
      );
    } finally {
      await owner.dispose();
      sqlite.close();
    }
  },
);
