import assert from 'node:assert/strict';
import test from 'node:test';

import { Methods, type PendingDecision, type Run } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
  resourceQuery,
  type ResourceReadResult,
} from '@farmslot/protocol/client-cache';

import {
  contentPrefetchTargets,
  createOwnerContentPrefetch,
  fetchRunArtifactBytes,
} from './content-prefetch.js';
import { clearGatewayMemoryAuth, setGatewayMemoryAuth } from './gateway-url.js';

Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: new URL('http://localhost:7777/'),
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function gateDecision(fields: Partial<PendingDecision>): PendingDecision {
  return {
    id: 'decision',
    type: 'engine_human_gate',
    slotId: 'slot',
    title: 'Gate',
    description: '',
    context: {},
    actions: [],
    createdAt: '2026-10-27T00:00:00.000Z',
    payload: { kind: 'ready' } as PendingDecision['payload'],
    ...fields,
  };
}

test('targets list pending ready gates first, then active runs with their last update', () => {
  const targets = contentPrefetchTargets(
    [
      gateDecision({ id: 'a', runMeta: { runId: 'gate-a' } as PendingDecision['runMeta'] }),
      gateDecision({ id: 'b', context: { runId: 'gate-b' } }),
      gateDecision({
        id: 'review',
        context: { runId: 'review-run' },
        payload: { kind: 'review' } as PendingDecision['payload'],
      }),
      gateDecision({ id: 'other', type: 'engine_review_posting', context: { runId: 'other' } }),
    ],
    [
      { id: 'active-old', updatedAt: '2026-10-27T01:00:00.000Z', decisions: [] },
      { id: 'gate-a', updatedAt: '2026-10-27T03:00:00.000Z', decisions: [] },
      {
        id: 'active-gated',
        updatedAt: '2026-10-27T02:00:00.000Z',
        decisions: [
          { type: 'engine_human_gate', payload: { kind: 'ready' } },
        ] as unknown as Run['decisions'],
      },
    ],
  );
  assert.deepEqual(targets, [
    { runId: 'gate-a', gate: true, updatedAt: '2026-10-27T03:00:00.000Z' },
    { runId: 'gate-b', gate: true, updatedAt: '2026-10-27T00:00:00.000Z' },
    { runId: 'active-old', gate: false, updatedAt: '2026-10-27T01:00:00.000Z' },
    { runId: 'active-gated', gate: true, updatedAt: '2026-10-27T02:00:00.000Z' },
  ]);
});

function fakeTransport(
  batchedContent: boolean,
  reply: (method: string, params: unknown) => ResourceReadResult<unknown> | undefined = () =>
    undefined,
) {
  const reads: Array<{ method: string; params: unknown }> = [];
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'none',
    scope: { gatewayUrl: 'ws://prefetch.test' },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      ...(batchedContent ? { batchedContent: true } : {}),
      resourceChanges: {
        version: 1,
        epoch: 'prefetch',
        versionLists: false,
        observedReads: 1,
        workspaceReads: 1,
      },
    } as ResourceCacheConnection['capabilities'],
  };
  const transport: ResourceCacheTransport = {
    getConnection: () => connection,
    onConnectionChange: () => () => {},
    onResourceChanged: () => () => {},
    resynchronize() {},
    request<T>(method: string, params: unknown) {
      reads.push({ method, params });
      const result = reply(method, params);
      // Unanswered reads stay open: the test observes which reads prefetch starts, in order.
      return result
        ? Promise.resolve(result as ResourceReadResult<T>)
        : new Promise<ResourceReadResult<T>>(() => {});
    },
  };
  return { transport, reads };
}

test('only a persistent owner store prefetches, and only when the gateway advertises batched content', async (t) => {
  const targets = [
    { runId: 'active', gate: false, updatedAt: '2026-10-27T05:00:00.000Z' },
    { runId: 'gate', gate: true },
  ];
  for (const [label, persistent, batchedContent, expected] of [
    ['memory store in another tab', false, true, []],
    ['owner without batchedContent', true, false, []],
    ['owner with batchedContent', true, true, ['gate', 'active']],
  ] as const) {
    const { transport, reads } = fakeTransport(batchedContent);
    const cache = createGatewayResourceCache({ transport, store: createMemoryResourceStore() });
    t.after(() => cache.dispose());
    const owner = createOwnerContentPrefetch({
      transport,
      request: () => new Promise(() => {}),
      readArtifact: () => new Promise(() => {}),
    });
    owner.setTargets(targets);
    owner.sync(cache, persistent);
    await flush();
    assert.deepEqual(
      reads.map(({ method, params }) => `${method}:${Reflect.get(params as object, 'runId')}`),
      expected.map((runId) => `run.get:${runId}`),
      label,
    );
    // The prefetcher goes with its cache: later targets start nothing.
    owner.sync(undefined, persistent);
    owner.setTargets([{ runId: 'later', gate: true }]);
    await flush();
    assert.equal(reads.length, expected.length, label);
  }
});

test('artifact reads send gateway auth and report a refusal as AUTH_FORBIDDEN', async (t) => {
  setGatewayMemoryAuth({ token: 'service-fixture' }, 'ws://localhost:7777/ws');
  t.after(clearGatewayMemoryAuth);
  const calls: Array<{ url: string; authorization: string | null }> = [];
  let status = 200;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    return new Response(status === 200 ? 'diff bytes' : null, { status });
  });
  const artifact = { runId: 'run', path: 'artifacts/diff.txt', bundleDigest: 'digest' };
  assert.equal(new TextDecoder().decode(await fetchRunArtifactBytes(artifact)), 'diff bytes');
  const url = new URL(calls[0].url, 'http://localhost:7777');
  assert.equal(url.pathname, '/api/run-artifact');
  assert.equal(url.searchParams.get('path'), 'artifacts/diff.txt');
  assert.equal(url.searchParams.get('bundleDigest'), 'digest');
  assert.equal(calls[0].authorization, 'Bearer service-fixture');
  for (status of [401, 403])
    await assert.rejects(fetchRunArtifactBytes(artifact), { code: 'AUTH_FORBIDDEN' });
  status = 500;
  await assert.rejects(fetchRunArtifactBytes(artifact), (error: unknown) => {
    assert.notEqual(Reflect.get(error as object, 'code'), 'AUTH_FORBIDDEN');
    return true;
  });
});

test('an ended person session refuses artifact reads, so prefetch stops for the connection', async (t) => {
  setGatewayMemoryAuth(
    { token: `fsa_${'a'.repeat(32)}_${'b'.repeat(43)}` },
    'ws://localhost:7777/ws',
  );
  t.after(clearGatewayMemoryAuth);
  const artifactReads: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    artifactReads.push(String(input));
    return new Response(null, { status: 401 });
  });
  await assert.rejects(fetchRunArtifactBytes({ runId: 'run', path: 'package.diff' }), {
    code: 'AUTH_REQUIRED',
  });

  const gateRun = (id: string) =>
    ({
      id,
      slotId: 'slot',
      engineState: { publishGate: { packageId: `${id}-package` } },
      decisions: [
        {
          id: `${id}-gate`,
          type: 'engine_human_gate',
          payload: {
            kind: 'ready',
            prPackage: {
              id: `${id}-package`,
              reviewSnapshot: { diffPath: 'package.diff', diffHash: 'f'.repeat(64) },
            },
          },
        },
      ],
    }) as unknown as Run;
  const { transport, reads } = fakeTransport(true, (method, params) => {
    if (method !== Methods.RUN_GET) return undefined;
    const runId = Reflect.get(params as object, 'runId') as string;
    const query = resourceQuery(Methods.RUN_GET, { runId });
    return {
      data: { run: gateRun(runId) },
      resourceState: {
        epoch: 'prefetch',
        dependencies: query.dependencies.map((key) => ({ key, revision: 0 })),
      },
    };
  });
  const cache = createGatewayResourceCache({ transport, store: createMemoryResourceStore() });
  t.after(() => cache.dispose());
  const owner = createOwnerContentPrefetch({
    transport,
    request: () => new Promise(() => {}),
    readArtifact: fetchRunArtifactBytes,
  });
  owner.sync(cache, true);
  owner.setTargets([{ runId: 'first', gate: true }]);
  await flush();
  assert.equal(artifactReads.length, 2, 'the first gate read its diff once');
  owner.setTargets([
    { runId: 'first', gate: true },
    { runId: 'second', gate: true },
  ]);
  await flush();
  assert.deepEqual(
    reads.map(({ params }) => Reflect.get(params as object, 'runId')),
    ['first'],
    'nothing starts after the refusal',
  );
  assert.equal(artifactReads.length, 2);
  owner.sync(undefined, false);
});
