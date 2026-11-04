import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { PendingDecision } from '@farmslot/protocol';
import { createMemoryResourceStore, type ResourceStore } from '@farmslot/protocol/client-cache';
import { resourceQuery } from '@farmslot/protocol/client-cache';

import { storedRun } from '../../../../packages/protocol/test/fixtures/run.js';

import { installFakeGateway } from './testing/fake-gateway.js';

// Unavailable persistent storage falls back to memory without prefetching.
let persistentStore = false;
mock.module('@farmslot/local-store/browser', {
  namedExports: {
    async createBrowserSqliteResourceStore(): Promise<ResourceStore> {
      const memory = createMemoryResourceStore();
      return {
        ...memory,
        persistent: persistentStore,
        get deleted() {
          return memory.deleted;
        },
      };
    },
    closeBrowserResourceStores() {},
  },
});

test('a durable store prefetches pending gates and active runs from the shared observations', async (t) => {
  const fakeGateway = installFakeGateway(t, 'operator');
  fakeGateway.resourceEpoch = 'prefetch-epoch';
  const authPayload = (batchedContent: boolean) => ({
    ok: true,
    authMode: 'token',
    capabilities: {
      workspaceAccess: 'farm',
      ...(batchedContent ? { batchedContent: true } : {}),
      resourceChanges: {
        version: 1,
        epoch: fakeGateway.resourceEpoch,
        versionLists: false,
        observedReads: 1,
      },
    },
    principal: {
      id: 'operator',
      generation: 0,
      subjectKind: 'service',
      displayName: 'operator',
      roles: [{ role: 'admin', scope: { kind: 'global' } }],
    },
  });
  const stamp = (family: string) => ({
    epoch: fakeGateway.resourceEpoch,
    dependencies: [{ key: { family, scope: 'farm' }, revision: 0 }],
  });
  const activeRun = storedRun('active-run', { status: 'monitoring' });
  const gate = {
    id: 'gate-decision',
    type: 'engine_human_gate',
    slotId: 'slot',
    title: 'Ready',
    description: '',
    context: {},
    actions: [],
    createdAt: '2026-10-27T01:00:00.000Z',
    runMeta: { runId: 'gate-run' },
    payload: { kind: 'ready' },
  } as unknown as PendingDecision;
  const gateRun = storedRun('gate-run', { status: 'human-gating', decisions: [gate] });
  fakeGateway.responseForRequest = ({ method, params }) => {
    if (method === 'run.list')
      return {
        payload: { runs: [activeRun, gateRun], totalCount: 2 },
        resourceState: stamp('runs'),
      };
    if (method === 'decision.list')
      return { payload: { decisions: [gate] }, resourceState: stamp('decisions') };
    if (method === 'run.get')
      return {
        payload: { run: Reflect.get(params ?? {}, 'runId') === gateRun.id ? gateRun : activeRun },
        resourceState: {
          epoch: fakeGateway.resourceEpoch,
          dependencies: resourceQuery(method, params).dependencies.map((key) => ({
            key,
            revision: 0,
          })),
        },
      };
    if (method === 'config.projects') return { payload: { projects: [] } };
    if (method === 'pr.list') return { payload: { prs: [] } };
    if (method === 'workGraph.list') return { payload: { graphs: [] } };
    if (method === 'fleet.status') return undefined;
    return { payload: { items: [] } };
  };

  const { gateway } = await import('./gateway-client.js');
  const { initState } = await import('./state.js');
  const { disposeResourceCache, getResourceCache, initializeResourceCache } =
    await import('./resource-cache.js');
  fakeGateway.beforeRestore = async () => {
    gateway.disconnect();
    await disposeResourceCache();
  };
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const prefetchReads = () =>
    fakeGateway.requests
      .filter(({ method }) => method === 'run.get')
      .map(({ params }) => Reflect.get(params as object, 'runId'));

  // A memory fallback never prefetches, even with the capability.
  fakeGateway.authPayload = authPayload(true);
  initState();
  await gateway.setAuthCredentials({ token: 'operator-secret' });
  gateway.connect();
  await flush();
  assert.equal(gateway.connectionState, 'connected');
  assert.ok(getResourceCache());
  assert.ok(fakeGateway.requests.some(({ method }) => method === 'decision.list'));
  assert.deepEqual(prefetchReads(), []);

  // Detail sync is independent of batched content; media prefetch still needs that capability.
  await disposeResourceCache();
  persistentStore = true;
  fakeGateway.authPayload = authPayload(false);
  initializeResourceCache();
  gateway.reconnect();
  await flush();
  assert.equal(gateway.connectionState, 'connected');
  assert.deepEqual(prefetchReads(), ['gate-run', 'active-run']);

  // With the capability, the owner prefetches the pending gate first, then the active run.
  fakeGateway.requests.length = 0;
  fakeGateway.authPayload = authPayload(true);
  gateway.reconnect();
  await flush();
  assert.equal(gateway.connectionState, 'connected');
  assert.deepEqual(prefetchReads(), ['gate-run', 'active-run']);

  // Disposing the cache disposes its prefetcher: a new connection starts nothing more.
  await disposeResourceCache();
  gateway.reconnect();
  await flush();
  assert.deepEqual(prefetchReads(), ['gate-run', 'active-run']);
});
