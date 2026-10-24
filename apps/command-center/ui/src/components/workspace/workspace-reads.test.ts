import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type GatewayResourceCache,
  type ResourceCacheTransport,
  resourceQuery,
  type ResourceReadResult,
} from '@farmslot/protocol/client-cache';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';

let cache: GatewayResourceCache | undefined;
let owner = 'first-owner';
const ownerListeners = new Set<() => void>();
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceCache: () => cache,
    getResourceNativeOwnerId: () => owner,
    getResourceWorkspaceKey: () => owner,
    subscribeResourceCache: (listener: () => void) => {
      ownerListeners.add(listener);
      return () => ownerListeners.delete(listener);
    },
  },
});
const { WorkspaceReads } = await import('./workspace-reads.js');

test('workspace views share canonical reads, stale data cannot authorize edits, and former owner responses are dropped', async (t) => {
  const query = resourceQuery<{ content: string }>('fs.read', {
    slotId: 'slot',
    runId: 'run',
    path: 'opened.ts',
  });
  let requests = 0;
  let resolveRead!: (reply: unknown) => void;
  const transport: ResourceCacheTransport = {
    getConnection: () => ({
      id: 1,
      connected: true,
      authMode: 'none',
      scope: { gatewayUrl: 'ws://workspace.test' },
      capabilities: {
        httpBearerAuth: true,
        voiceInstructionFormatting: false,
        resourceChanges: {
          version: 1,
          epoch: 'workspace',
          versionLists: false,
          observedReads: 1,
          workspaceReads: 1,
        },
      },
    }),
    resynchronize() {},
    onConnectionChange: () => () => {},
    onResourceChanged: () => () => {},
    request: <T>() => {
      requests++;
      return new Promise((resolve) => {
        resolveRead = resolve as (reply: unknown) => void;
      }) as Promise<ResourceReadResult<T>>;
    },
  };
  const ownedCache = createGatewayResourceCache({ transport });
  cache = ownedCache;
  const firstHost = new FakeControllerHost();
  const secondHost = new FakeControllerHost();
  let retired = 0;
  const first = new WorkspaceReads(
    firstHost,
    () => {},
    () => 'run',
    () => retired++,
  );
  const second = new WorkspaceReads(
    secondHost,
    () => {},
    () => 'run',
  );
  firstHost.connect();
  secondHost.connect();
  t.after(async () => {
    firstHost.disconnect();
    secondHost.disconnect();
    await ownedCache.dispose();
    cache = undefined;
    owner = 'first-owner';
  });
  const firstValues: string[] = [];
  const secondValues: string[] = [];
  const a = first.read<{ content: string }>(
    'fs.read',
    { slotId: 'slot', path: 'opened.ts' },
    (row) => firstValues.push(row.content),
  );
  const b = second.read<{ content: string }>(
    'fs.read',
    { path: 'opened.ts', slotId: 'slot' },
    (row) => secondValues.push(row.content),
  );
  const end = Date.now() + 500;
  while (!resolveRead && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(requests, 1);
  assert.equal(first.ready, false);
  resolveRead({
    data: { content: 'saved' },
    resourceState: {
      epoch: 'workspace',
      dependencies: query.dependencies.map((key) => ({ key, revision: 0 })),
    },
  });
  await Promise.all([a, b]);
  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  const saved = ownedCache.read(query).data;
  assert(first.hasData && first.owns(saved));
  // Switching profiles retires rendered bytes immediately, before another reply is available.
  const refreshing = ownedCache.retry(query);
  const deadline = Date.now() + 500;
  while (requests < 2 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(requests, 2);
  cache = undefined;
  owner = 'replacement-owner';
  for (const listener of ownerListeners) listener();
  assert.equal(retired, 1);
  assert.equal(first.hasData, false);
  assert.equal(first.owns(saved), false);
  assert.equal(first.ready, false);
  resolveRead({
    data: { content: 'former-response' },
    resourceState: {
      epoch: 'workspace',
      dependencies: query.dependencies.map((key) => ({ key, revision: 0 })),
    },
  });
  await refreshing;
  firstHost.disconnect();
  secondHost.disconnect();
  assert.deepEqual(firstValues, ['saved']);
  assert.deepEqual(secondValues, ['saved']);
});

test('saved opened files hydrate without a connection and never grant current workspace actions', async (t) => {
  const query = resourceQuery<{ content: string }>('fs.read', {
    slotId: 'cold-slot',
    path: 'opened.txt',
  });
  const scope = { gatewayUrl: 'ws://cold-workspace.test' };
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority: { roles: [], workspaceAccess: 'farm' } });
  await store.putQuery({
    id: query.id,
    data: { content: 'saved offline' },
    observedAt: 123,
    bytes: 27,
  });
  const transport: ResourceCacheTransport = {
    getConnection: () => ({ id: 0, connected: false, authMode: 'none', scope }),
    onConnectionChange: () => () => {},
    onResourceChanged: () => () => {},
    resynchronize() {},
    request: () => assert.fail('Offline hydration cannot issue a gateway read'),
  };
  const savedCache = createGatewayResourceCache({ transport, store });
  cache = savedCache;
  const host = new FakeControllerHost();
  const reads = new WorkspaceReads(host);
  host.connect();
  t.after(async () => {
    host.disconnect();
    await savedCache.dispose();
    cache = undefined;
  });
  let rendered = '';
  const data = await reads.read<{ content: string }>('fs.read', query.params, (value) => {
    rendered = value.content;
  });
  assert.equal(rendered, 'saved offline');
  assert.equal(reads.ready, false);
  assert.equal(reads.hasData, true);
  assert.equal(reads.owns(data), true);
  assert.equal(savedCache.read(query).observedAt, 123);
});
