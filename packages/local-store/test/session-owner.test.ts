import assert from 'node:assert/strict';
import test from 'node:test';

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

const url = 'ws://session.invalid/';
const scope = { gatewayUrl: url, principalId: 'old', principalGeneration: 0 };
const authority = { roles: [], workspaceAccess: 'farm' as const };
const saved: ResourceStoreIdentity = { authMode: 'token', metadata: { scope, authority } };
const query = { ...resourceQuery<{ value: string }>('sources.status'), persisted: true };

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
