import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { mock } from 'node:test';

import {
  type DecisionListResult,
  type GatewayAuthConnectResult,
  HUMAN_GATE_DECISION_TYPE,
  reviewDiffHash,
  reviewSnapshotIdentityText,
  type Run,
  type RunGetResult,
} from '@farmslot/protocol';
import {
  createMemoryResourceStore,
  type GatewayResourceCache,
  gitBlobHash,
  resourceDependenciesForRead,
  resourceQuery,
  type ResourceStore,
} from '@farmslot/protocol/client-cache';

import {
  contentPrefetchTargets,
  startContentPrefetch as startRealContentPrefetch,
} from './content-prefetch';
import { artifactImageKey, gateDiffSource, imageDataUri, openHeldContent } from './held-content';

const GATEWAY = 'ws://gateway.invalid/ws';
const BASE = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);
const OLD = 'one\ntwo\n';
const NEW = 'one\n2\n';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const bytes = (value: string) => new TextEncoder().encode(value);
const blob = (value: string) => gitBlobHash(bytes(value));
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  `index ${blob(OLD)}..${blob(NEW)} 100644`,
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' one',
  '-two',
  '+2',
  '',
].join('\n');
const DIFF_HASH = reviewDiffHash(reviewSnapshotIdentityText(DIFF, []));
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');
const ARTIFACTS = new Map([
  ['review/package.diff', bytes(DIFF)],
  ['evidence/after.png', PNG],
]);

const gateRun = {
  id: 'run-gate',
  slotId: 'slot-gate',
  updatedAt: '2026-10-27T01:00:00.000Z',
  engineState: { publishGate: { packageId: 'package-1' } },
  decisions: [
    {
      id: 'gate-1',
      type: HUMAN_GATE_DECISION_TYPE,
      payload: {
        kind: 'ready',
        prPackage: {
          id: 'package-1',
          headSha: HEAD,
          artifactBundle: { bundleDigest: 'bundle-1' },
          reviewSnapshot: {
            source: 'local-git',
            baseSha: BASE,
            headSha: HEAD,
            diffPath: 'review/package.diff',
            diffHash: DIFF_HASH,
            capturedAt: '2026-10-27T00:00:00.000Z',
          },
          evidenceManifest: [
            {
              path: 'evidence/after.png',
              purpose: 'screenshot',
              sizeBytes: PNG.byteLength,
              sha256: PNG_SHA,
            },
          ],
        },
      },
    },
  ],
} as unknown as Run;
// Updated later than the gate: gates still go first.
const activeRun = {
  id: 'run-active',
  slotId: null,
  updatedAt: '2026-10-27T02:00:00.000Z',
  decisions: [],
} as unknown as Run;
const runs = new Map([
  [gateRun.id, gateRun],
  [activeRun.id, activeRun],
]);
const decisions = {
  decisions: [
    {
      id: 'gate-1',
      type: HUMAN_GATE_DECISION_TYPE,
      slotId: 'slot-gate',
      title: 'Publish',
      description: '',
      context: {},
      actions: [],
      createdAt: '2026-10-27T00:30:00.000Z',
      runMeta: { runId: 'run-gate', flowType: 'dev', ticketOrPr: 'gate' },
      payload: { kind: 'ready' },
    },
  ],
} as unknown as DecisionListResult;

function auth(batchedContent: boolean): GatewayAuthConnectResult {
  return {
    ok: true,
    clientKind: 'companion',
    authMode: 'token',
    authenticatedAt: Date.now(),
    principal: {
      id: 'operator',
      generation: 0,
      displayName: 'Operator',
      subjectKind: 'service',
      roles: [],
    },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      workspaceAccess: 'farm',
      resourceChanges: { version: 1, epoch: 'test', versionLists: false },
      ...(batchedContent ? { batchedContent: true } : {}),
    },
  };
}

class FakeClient {
  connectionState: 'connected' | 'disconnected' = 'connected';
  connectionGeneration = 1;
  resourceConnectionReason = undefined;
  readonly gatewayUrl = GATEWAY;
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly listeners = new Set<() => void>();
  constructor(public authenticatedConnection: GatewayAuthConnectResult) {}
  async requestResource(method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params });
    const data =
      method === 'run.list'
        ? { runs: [activeRun, gateRun], totalCount: 2 }
        : method === 'decision.list'
          ? decisions
          : method === 'run.get'
            ? { run: runs.get(String(params.runId)) }
            : undefined;
    return {
      data,
      resourceState: {
        epoch: 'test',
        dependencies: (resourceDependenciesForRead(method, params) ?? []).map((key) => ({
          key,
          revision: 0,
        })),
      },
    };
  }
  async request(method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params });
    assert.equal(method, 'git.show');
    return {
      entries: [
        {
          path: 'src/a.ts',
          status: 'ok',
          id: blob(OLD),
          size: OLD.length,
          content: Buffer.from(OLD).toString('base64'),
        },
      ],
      cursor: 'src/a.ts',
      hasMore: false,
    };
  }
  subscribe() {
    return () => {};
  }
  onConnectionChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  reconnect() {}
  /** The connection store hears the client first, as its subscription predates the cache's. */
  setConnected(connected: boolean) {
    this.connectionState = connected ? 'connected' : 'disconnected';
    setState({});
    for (const listener of [...this.listeners]) listener();
  }
}

let state = {
  client: null as FakeClient | null,
  gatewayUrl: GATEWAY,
  signedOut: false,
  activeProfileId: 'profile-a',
  activeProfileHttpAuthHeaders: { Authorization: 'Bearer artifact-token' } as Record<
    string,
    string
  >,
};
const storeListeners = new Set<() => void>();
function setState(next: Partial<typeof state>) {
  state = { ...state, ...next };
  for (const listener of [...storeListeners]) listener();
}
mock.module('../store/connection', {
  namedExports: {
    useConnectionStore: {
      getState: () => state,
      subscribe(listener: () => void) {
        storeListeners.add(listener);
        return () => storeListeners.delete(listener);
      },
    },
  },
});
mock.module('react-native', {
  namedExports: {
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
  },
});
const saved = new Map<string, string>();
mock.module('@react-native-async-storage/async-storage', {
  defaultExport: {
    getItem: async (key: string) => saved.get(key) ?? null,
    setItem: async (key: string, value: string) => void saved.set(key, value),
    removeItem: async (key: string) => void saved.delete(key),
  },
});
const stores: ResourceStore[] = [];
mock.module('@farmslot/local-store/native', {
  namedExports: {
    createNativeSqliteResourceStore: async () => {
      const store = createMemoryResourceStore();
      stores.push(store);
      return store;
    },
  },
});
// The real prefetcher, recorded per cache so the test sees when each one starts and stops.
const prefetchers: Array<{ cache: GatewayResourceCache; stopped: boolean }> = [];
mock.module('./content-prefetch', {
  namedExports: {
    contentPrefetchTargets,
    startContentPrefetch(options: Parameters<typeof startRealContentPrefetch>[0]) {
      const entry = { cache: options.cache, stopped: false };
      prefetchers.push(entry);
      const stop = startRealContentPrefetch(options);
      return () => {
        entry.stopped = true;
        stop();
      };
    },
  },
});

const fetches: Array<{ url: URL; headers: Record<string, string> }> = [];
globalThis.fetch = (async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  fetches.push({ url, headers: init?.headers as Record<string, string> });
  const data = ARTIFACTS.get(url.searchParams.get('path') ?? '');
  return data ? new Response(data) : new Response(null, { status: 404 });
}) as typeof fetch;

const flush = async () => {
  for (let index = 0; index < 60; index++) await new Promise((resolve) => setImmediate(resolve));
};

test('pending gates come before active runs, each ordered by its last update', () => {
  assert.deepEqual(
    contentPrefetchTargets({ runs: [activeRun, gateRun], totalCount: 2 }, decisions),
    [
      { runId: 'run-gate', gate: true, updatedAt: '2026-10-27T01:00:00.000Z' },
      { runId: 'run-active', gate: false, updatedAt: '2026-10-27T02:00:00.000Z' },
    ],
  );
  // A gate the decision list has not listed yet is still recognised from its run.
  assert.deepEqual(contentPrefetchTargets({ runs: [gateRun], totalCount: 1 }, undefined), [
    { runId: 'run-gate', gate: true, updatedAt: '2026-10-27T01:00:00.000Z' },
  ]);
  assert.deepEqual(contentPrefetchTargets(undefined, decisions), [
    { runId: 'run-gate', gate: true, updatedAt: '2026-10-27T00:30:00.000Z' },
  ]);
});

test('each persistent cache gets one prefetcher that fills it through the gateway client and stops with it; the gate then opens offline from held content', async () => {
  const { getResourceCache, initializeNativeResourceCache } = await import('./resource-cache');
  const client = new FakeClient(auth(true));
  setState({ client });
  const stop = initializeNativeResourceCache();
  try {
    await flush();
    const cache = getResourceCache()!;
    assert.equal(prefetchers.length, 1);
    assert.equal(prefetchers[0]!.cache, cache);

    const runReads = client.calls.filter(({ method }) => method === 'run.get');
    assert.deepEqual(
      runReads.map(({ params }) => params.runId),
      ['run-gate', 'run-active'],
    );
    assert.deepEqual(
      client.calls.find(({ method }) => method === 'git.show')?.params,
      { slotId: 'slot-gate', ref: BASE, paths: ['src/a.ts'] },
      'base files come through the gateway client at the snapshot base',
    );
    assert.deepEqual(
      fetches.map(({ url }) => [
        url.pathname,
        url.searchParams.get('runId'),
        url.searchParams.get('path'),
        url.searchParams.get('bundleDigest'),
      ]),
      [
        ['/api/run-artifact', 'run-gate', 'review/package.diff', 'bundle-1'],
        ['/api/run-artifact', 'run-gate', 'evidence/after.png', 'bundle-1'],
      ],
    );
    for (const { headers } of fetches) assert.equal(headers.Authorization, 'Bearer artifact-token');
    for (const key of [
      { kind: 'diff', id: DIFF_HASH },
      { kind: 'artifact', id: PNG_SHA },
      { kind: 'blob', id: blob(OLD) },
      { kind: 'blob', id: blob(NEW) },
    ] as const)
      assert.equal(await cache.hasContent(key), true, `${key.kind} is held`);

    // Offline: the gate renders from the stored run and held content, with no live read.
    client.setConnected(false);
    await flush();
    // The gate screen observes its run as useResourceQuery does.
    const runQuery = resourceQuery<RunGetResult>('run.get', { runId: 'run-gate' });
    const stopRun = cache.observe(runQuery, () => {});
    await flush();
    const run = cache.read(runQuery);
    stopRun();
    assert.equal(run.status, 'stale');
    const source = gateDiffSource(run.data!.run)!;
    const diff = await openHeldContent({ cache, key: source.key, cohort: 'gate' });
    assert.equal(new TextDecoder().decode(diff), DIFF);
    const payload = run.data!.run.decisions[0]!.payload;
    assert.ok(payload?.kind === 'ready');
    const imageKey = artifactImageKey(payload.prPackage!.evidenceManifest![0]!)!;
    const image = await openHeldContent({ cache, key: imageKey, cohort: 'gate' });
    assert.equal(
      imageDataUri(image!),
      `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    );
    const origins = Object.fromEntries(
      (await stores.at(-1)!.listContent()).map((row) => [`${row.kind}:${row.id}`, row.origin]),
    );
    assert.equal(origins[`diff:${DIFF_HASH}`], 'opened');
    assert.equal(origins[`artifact:${PNG_SHA}`], 'opened');
    assert.equal(origins[`blob:${blob(OLD)}`], 'prefetch');
    assert.equal(fetches.length, 2, 'opening held content transfers nothing');

    // A profile change retires the cache, and its prefetcher with it; setConnection then binds
    // the client's next generation to a new cache.
    client.setConnected(true);
    client.connectionGeneration++;
    setState({ activeProfileId: 'profile-b' });
    await flush();
    assert.equal(prefetchers[0]!.stopped, true);
    assert.equal(prefetchers.length, 2);
    assert.equal(prefetchers[1]!.cache, getResourceCache());
    assert.notEqual(prefetchers[1]!.cache, cache);
  } finally {
    stop();
    await flush();
  }
  assert.ok(prefetchers.every(({ stopped }) => stopped));
  const reads = client.calls.length;
  client.connectionGeneration++;
  client.setConnected(true);
  await flush();
  assert.equal(client.calls.length, reads, 'a stopped prefetcher reads nothing');
});

test('a gateway without capabilities.batchedContent gets no prefetch', async () => {
  const { initializeNativeResourceCache } = await import('./resource-cache');
  const client = new FakeClient(auth(false));
  const fetched = fetches.length;
  setState({ client, activeProfileId: 'profile-c' });
  const stop = initializeNativeResourceCache();
  try {
    await flush();
    assert.equal(prefetchers.at(-1)?.stopped, false, 'the prefetcher exists but stays idle');
    assert.deepEqual(
      client.calls.filter(({ method }) => method === 'run.get' || method === 'git.show'),
      [],
    );
    assert.ok(client.calls.some(({ method }) => method === 'run.list'));
    assert.equal(fetches.length, fetched);
  } finally {
    stop();
    await flush();
  }
});
