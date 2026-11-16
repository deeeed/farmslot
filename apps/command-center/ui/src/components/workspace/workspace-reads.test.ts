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
  let rejectRead!: (error: Error) => void;
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
      return new Promise((resolve, reject) => {
        rejectRead = reject;
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
  let settled = false;
  void a.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  rejectRead(
    Object.assign(new Error('The local file watches are still arming.'), {
      code: 'RESOURCE_OBSERVATION_UNAVAILABLE',
    }),
  );
  const absentEnd = Date.now() + 2000;
  while (
    !first.stateOf('fs.read', { slotId: 'slot', path: 'opened.ts' })?.error &&
    Date.now() < absentEnd
  )
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(first.error, '');
  assert.equal(first.ready, false);
  assert.equal(settled, false, 'Expected absence keeps the read pending, not failed');
  const supported = ownedCache.retry(query);
  const supportedEnd = Date.now() + 2000;
  while (requests < 2 && Date.now() < supportedEnd)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(requests, 2);
  resolveRead({
    data: { content: 'saved' },
    resourceState: {
      epoch: 'workspace',
      dependencies: query.dependencies.map((key) => ({ key, revision: 0 })),
    },
  });
  await Promise.all([a, b, supported]);
  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  const saved = ownedCache.read(query).data;
  assert(first.hasData && first.owns(saved));
  // The same UNAVAILABLE code also wraps real producer failures; those must reject.
  const denied = first.read('fs.read', { slotId: 'slot', path: 'forbidden.ts' }, () =>
    assert.fail('A failed read cannot apply data'),
  );
  const failureEnd = Date.now() + 2000;
  while (requests < 3 && Date.now() < failureEnd)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(requests, 3);
  rejectRead(
    Object.assign(new Error('EACCES: permission denied, watch workspace'), {
      code: 'RESOURCE_OBSERVATION_UNAVAILABLE',
    }),
  );
  await assert.rejects(denied, /EACCES/);
  assert.match(first.error, /EACCES/);
  assert.equal(first.ready, false);
  first.drop('fs.read', { slotId: 'slot', path: 'forbidden.ts' });
  assert.equal(first.ready, true);
  // Switching profiles retires rendered bytes immediately, before another reply is available.
  const refreshing = ownedCache.retry(query);
  const deadline = Date.now() + 500;
  while (requests < 4 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(requests, 4);
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

test('one read is found by the name read gives it, run pin included', async (t) => {
  const params = { slotId: 'pinned-slot', path: 'opened.txt' };
  const pinned = resourceQuery<{ content: string }>('fs.read', { ...params, runId: 'run-1' });
  const scope = { gatewayUrl: 'ws://pinned-workspace.test' };
  const store = createMemoryResourceStore();
  await store.setMetadata({ scope, authority: { roles: [], workspaceAccess: 'farm' } });
  await store.putQuery({ id: pinned.id, data: { content: 'saved' }, observedAt: 456, bytes: 18 });
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
  const reads = new WorkspaceReads(
    host,
    () => {},
    () => 'run-1',
  );
  host.connect();
  t.after(async () => {
    host.disconnect();
    await savedCache.dispose();
    cache = undefined;
    owner = 'first-owner';
  });
  await reads.read('fs.read', params, () => {});
  assert.equal(reads.stateOf('fs.read', params)?.observedAt, 456);
  assert.equal(reads.stateOf('fs.read', { ...params, path: 'other.txt' }), undefined);
  owner = 'another-owner';
  assert.equal(reads.stateOf('fs.read', params), undefined, 'another owner sees nothing');
  owner = 'first-owner';
  host.disconnect();
  assert.equal(reads.stateOf('fs.read', params), undefined);
});
