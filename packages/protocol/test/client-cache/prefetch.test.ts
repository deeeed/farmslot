import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createGatewayResourceCache } from '../../src/client-cache/cache.js';
import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import { gitBlobHash, verifyResourceContent } from '../../src/client-cache/content.js';
import type { ResourceKey } from '../../src/client-cache/keys.js';
import {
  activeRunDiffBase,
  activeRunDiffQuery,
  type ContentPrefetchArtifact,
  type ContentPrefetchOptions,
  type ContentPrefetchTarget,
  createContentPrefetcher,
} from '../../src/client-cache/prefetch.js';
import { type ResourceQuery, resourceQuery } from '../../src/client-cache/registry.js';
import {
  type ContentKey,
  createMemoryResourceStore,
  type ResourceContentPlacement,
  type ResourceStore,
} from '../../src/client-cache/store.js';
import type {
  ResourceCacheConnection,
  ResourceCacheTransport,
  ResourceContentInput,
  ResourceContentRetain,
  ResourceQueryState,
} from '../../src/client-cache/types.js';
import type { Run } from '../../src/contracts/runs.js';
import type { GitDiffResult } from '../../src/rpc/git.js';
import { Methods } from '../../src/rpc/registry.js';
import { reviewDiffHash, reviewSnapshotIdentityText } from '../../src/runs/review-diff-identity.js';
import type { ResourceChangedPayload } from '../../src/transport/events.js';

const ZERO = '0'.repeat(40);
const BASE = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);
const A_OLD = 'one\ntwo\nthree\n';
const A_NEW = 'one\n2\nthree\n';
const ADDED = 'hello\n';
const GONE = 'bye\n';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const A_HUNK = ['@@ -1,3 +1,3 @@', ' one', '-two', '+2', ' three'];

const bytes = (value: string) => new TextEncoder().encode(value);
const blob = (value: string) => gitBlobHash(bytes(value));
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

function modified(path: string, before: string, after: string, hunk: string[]) {
  return [
    `diff --git a/${path} b/${path}`,
    `index ${blob(before)}..${blob(after)} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunk,
  ];
}

function added(path: string, after: string) {
  const lines = after.split('\n').slice(0, -1);
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    `index ${ZERO}..${blob(after)}`,
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ];
}

function gateDiff(after = A_NEW, hunk = A_HUNK): string {
  return [
    ...modified('src/a.ts', A_OLD, after, hunk),
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    `index ${blob(GONE)}..${ZERO}`,
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/img.png b/img.png',
    `index ${'1'.repeat(40)}..${'2'.repeat(40)} 100644`,
    'Binary files a/img.png and b/img.png differ',
    ...added('src/new.ts', ADDED),
    '',
  ].join('\n');
}

const BATCHED = { httpBearerAuth: true, voiceInstructionFormatting: false, batchedContent: true };
const UNTRACKED = [
  { path: 'src/new.ts', blobSha: blob(ADDED), mode: '100644' as const },
  { path: 'empty.txt', blobSha: blob(''), mode: '100644' as const },
];

interface Call {
  method: string;
  params: Record<string, unknown>;
  placement?: ResourceContentPlacement;
}

function createWorld() {
  return {
    runs: new Map<string, Run>(),
    /** Git objects: ref, then path, then text. */
    objects: new Map<string, Map<string, string | Uint8Array>>(),
    worktree: new Map<string, GitDiffResult>(),
    frozen: new Map<string, GitDiffResult>(),
    heads: new Map<string, string>(),
    artifacts: new Map<string, Uint8Array>(),
    content: new Map<string, Uint8Array>(),
    /** Content whose bytes were loaded, as opposed to retained by identity. */
    reads: [] as string[],
    retains: [] as string[],
    stores: [] as ResourceContentInput[],
    calls: [] as Call[],
    pageSize: 100,
    refuseStore: (_input: ResourceContentInput) => false,
    fail: (_call: Call): string | undefined => undefined,
    block: (_call: Call): Promise<void> | undefined => undefined,
  };
}
type World = ReturnType<typeof createWorld>;

function gateRun(
  world: World,
  runId: string,
  packageId: string,
  diff: string,
  untrackedFiles = UNTRACKED,
): string {
  const diffHash = reviewDiffHash(reviewSnapshotIdentityText(diff, untrackedFiles));
  world.artifacts.set(`artifacts/${packageId}.diff`, bytes(diff));
  world.artifacts.set('evidence/a.png', PNG);
  world.runs.set(runId, {
    id: runId,
    slotId: `slot-${runId}`,
    engineState: { publishGate: { packageId } },
    decisions: [
      {
        id: `decision-${packageId}`,
        payload: {
          kind: 'ready',
          prPackage: {
            id: packageId,
            headSha: HEAD,
            artifactBundle: { bundleDigest: `bundle-${packageId}` },
            reviewSnapshot: {
              source: 'local-git',
              baseSha: BASE,
              headSha: HEAD,
              diffPath: `artifacts/${packageId}.diff`,
              diffHash,
              ...(untrackedFiles.length ? { untrackedFiles } : {}),
              capturedAt: '2026-10-27T00:00:00.000Z',
            },
            evidenceManifest: [
              {
                path: 'evidence/a.png',
                purpose: 'screenshot',
                sizeBytes: PNG.byteLength,
                sha256: sha256(PNG),
              },
              { path: 'evidence/run.mp4', purpose: 'video', sha256: 'f'.repeat(64) },
              { path: 'evidence/unhashed.png', purpose: 'screenshot' },
              {
                path: 'evidence/huge.png',
                purpose: 'screenshot',
                sizeBytes: 3 * 1024 * 1024,
                sha256: 'e'.repeat(64),
              },
            ],
          },
        },
      },
    ],
  } as unknown as Run);
  return diffHash;
}

/** The gateway's direct reads and artifact endpoint, answered from the world. */
function gateway(world: World) {
  async function enter(call: Call) {
    world.calls.push(call);
    await world.block(call);
    const code = world.fail(call);
    if (code) throw Object.assign(new Error(code), { code });
  }
  async function request<T>(method: string, params: unknown): Promise<T> {
    const value = params as Record<string, unknown>;
    await enter({ method, params: value });
    if (method === Methods.GIT_LOG)
      return { entries: [{ hash: world.heads.get(String(value.slotId)) }] } as T;
    if (method === Methods.GIT_DIFF) return world.frozen.get(String(value.runId)) as T;
    const objects = world.objects.get(String(value.ref)) ?? new Map<string, string>();
    const paths = value.paths as string[];
    const start = value.after === undefined ? 0 : paths.indexOf(String(value.after)) + 1;
    const page = paths.slice(start, start + world.pageSize);
    const have = (value.have ?? []) as string[];
    return {
      entries: page.map((path) => {
        const content = objects.get(path);
        if (content === undefined) return { path, status: 'missing' };
        const raw = typeof content === 'string' ? bytes(content) : content;
        const object = { path, id: gitBlobHash(raw), size: raw.byteLength };
        return have.includes(object.id)
          ? { ...object, status: 'held' }
          : { ...object, status: 'ok', content: Buffer.from(raw).toString('base64') };
      }),
      cursor: page[page.length - 1],
      hasMore: start + page.length < paths.length,
    } as T;
  }
  async function readArtifact(artifact: ContentPrefetchArtifact): Promise<Uint8Array> {
    await enter({ method: 'artifact', params: { ...artifact } });
    const data = world.artifacts.get(artifact.path);
    if (!data) throw new Error('missing artifact');
    return data;
  }
  return { enter, request, readArtifact };
}

function harness(
  world = createWorld(),
  capabilities: ResourceCacheConnection['capabilities'] = BATCHED,
  defaultBranch?: ContentPrefetchOptions['defaultBranch'],
) {
  let connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'http://gateway.test/' },
    capabilities,
  };
  const connectionListeners = new Set<(next: ResourceCacheConnection) => void>();
  const changeListeners = new Set<(payload: ResourceChangedPayload) => void>();
  const contentId = (key: ContentKey) => `${key.kind}:${key.id}`;
  const cache = {
    async retry<T>(
      query: ResourceQuery<T>,
      placement?: ResourceContentPlacement,
    ): Promise<ResourceQueryState<T>> {
      const params = query.params as Record<string, unknown>;
      try {
        await enter({ method: query.method, params, ...(placement ? { placement } : {}) });
      } catch (error) {
        return { status: 'error', error: { code: (error as { code: string }).code, message: '' } };
      }
      const data =
        query.method === Methods.RUN_GET
          ? { run: world.runs.get(String(params.runId)) }
          : world.worktree.get(String(params.slotId));
      return { status: 'ready', data: data as T, observedAt: Date.now() };
    },
    async retainContent(key: ContentKey, retain: ResourceContentRetain) {
      if (!world.content.has(contentId(key))) return false;
      world.retains.push(`${contentId(key)}:${retain.cohort}`);
      return true;
    },
    async readContent(key: ContentKey) {
      world.reads.push(contentId(key));
      return world.content.get(contentId(key));
    },
    contentWriteToken: () => ({ connectionId: connection.id, ownerVersion: 0, storeVersion: 0 }),
    async storeContent(input: ResourceContentInput) {
      world.stores.push(input);
      if (
        input.token?.connectionId !== connection.id ||
        world.refuseStore(input) ||
        !verifyResourceContent(input.key, input.data, input.untrackedFiles)
      )
        return false;
      world.content.set(contentId(input.key), input.data);
      return true;
    },
  };
  const { enter, request, readArtifact } = gateway(world);
  const prefetcher = createContentPrefetcher({
    transport: {
      getConnection: () => connection,
      onConnectionChange(listener) {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
      onResourceChanged(listener) {
        changeListeners.add(listener);
        return () => changeListeners.delete(listener);
      },
    },
    cache,
    request,
    readArtifact,
    defaultBranch,
  });
  return {
    world,
    prefetcher,
    connect(next: Partial<ResourceCacheConnection>) {
      connection = { ...connection, ...next };
      for (const listener of connectionListeners) listener(connection);
    },
    change(...keys: ResourceKey[]) {
      const payload: ResourceChangedPayload = {
        version: 1,
        epoch: 'epoch',
        changes: keys.map((key, revision) => ({ key, revision, kind: 'updated' })),
      };
      for (const listener of changeListeners) listener(payload);
    },
    calls: (method: string) => world.calls.filter((call) => call.method === method),
  };
}

async function flush() {
  for (let turn = 0; turn < 30; turn++) await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const target = (runId: string, gate: boolean, updatedAt?: string | number) =>
  ({ runId, gate, updatedAt }) satisfies ContentPrefetchTarget;

test('pending gates go first, then active runs by most recent update, two at a time', async () => {
  const { world, prefetcher } = harness();
  const releases = new Map<string, () => void>();
  let active = 0;
  let peak = 0;
  world.block = (call) => {
    const gate = deferred();
    releases.set(String(call.params.runId), () => {
      active--;
      gate.resolve();
    });
    peak = Math.max(peak, ++active);
    return gate.promise;
  };
  for (const runId of ['a1', 'g1', 'a2', 'g2'])
    world.runs.set(runId, { id: runId, slotId: null, decisions: [] } as unknown as Run);
  prefetcher.setTargets([
    target('a1', false, '2026-10-01T00:00:00.000Z'),
    target('g1', true, 1),
    target('a2', false, '2026-10-20T00:00:00.000Z'),
    target('g2', true, 5),
  ]);
  await flush();
  const started = () => world.calls.map((call) => call.params.runId);
  assert.deepEqual(started(), ['g2', 'g1']);
  releases.get('g2')!();
  await flush();
  assert.deepEqual(started(), ['g2', 'g1', 'a2']);
  releases.get('a2')!();
  await flush();
  assert.deepEqual(started(), ['g2', 'g1', 'a2', 'a1']);
  releases.get('g1')!();
  releases.get('a1')!();
  await flush();
  assert.equal(peak, 2);
  assert.equal(world.calls.length, 4);
});

test('an authorization refusal stops prefetch for the rest of the connection', async () => {
  const { world, prefetcher, connect, change } = harness();
  const g2 = deferred();
  world.block = (call) => (call.params.runId === 'g2' ? g2.promise : undefined);
  world.fail = (call) => (call.params.runId === 'g1' ? 'AUTH_FORBIDDEN' : undefined);
  for (const runId of ['g1', 'g2', 'a1'])
    world.runs.set(runId, { id: runId, slotId: null, decisions: [] } as unknown as Run);
  prefetcher.setTargets([target('g1', true, 2), target('g2', true, 1), target('a1', false)]);
  await flush();
  g2.resolve();
  prefetcher.setTargets([target('g1', true, 2), target('g2', true, 1), target('a1', false)]);
  change({ family: 'package', runId: 'g2' }, { family: 'workspace', slotId: 'slot' });
  connect({ foreground: false });
  connect({ foreground: true });
  await flush();
  assert.deepEqual(
    world.calls.map((call) => call.params.runId),
    ['g1', 'g2'],
  );
  world.fail = () => undefined;
  connect({ id: 2 });
  await flush();
  assert.deepEqual(
    world.calls.map((call) => call.params.runId),
    ['g1', 'g2', 'g1', 'g2', 'a1'],
  );
});

test('a gate reads run.get, its retained diff, batched bases, then evidence images', async () => {
  const { world, prefetcher } = harness();
  world.pageSize = 1;
  world.objects.set(
    BASE,
    new Map([
      ['src/a.ts', A_OLD],
      ['old.txt', GONE],
    ]),
  );
  const diffHash = gateRun(world, 'g1', 'p1', gateDiff());
  prefetcher.setTargets([target('g1', true)]);
  await flush();
  const show = { slotId: 'slot-g1', ref: BASE, paths: ['src/a.ts', 'old.txt'] };
  assert.deepEqual(world.calls, [
    { method: 'run.get', params: { runId: 'g1' } },
    {
      method: 'artifact',
      params: { runId: 'g1', path: 'artifacts/p1.diff', bundleDigest: 'bundle-p1' },
    },
    { method: 'git.show', params: show },
    { method: 'git.show', params: { ...show, after: 'src/a.ts' } },
    {
      method: 'artifact',
      params: { runId: 'g1', path: 'evidence/a.png', bundleDigest: 'bundle-p1' },
    },
  ]);
  assert.deepEqual(
    world.stores.map(({ key, origin, cohort }) => [key.kind, key.id, origin, cohort]),
    [
      ['diff', diffHash, 'prefetch', 'gate'],
      ['blob', blob(A_OLD), 'prefetch', 'gate'],
      ['blob', blob(A_NEW), 'prefetch', 'gate'],
      ['blob', blob(GONE), 'prefetch', 'gate'],
      ['blob', blob(ADDED), 'prefetch', 'gate'],
      ['blob', blob(''), 'prefetch', 'gate'],
      ['artifact', sha256(PNG), 'prefetch', 'gate'],
    ],
  );
  assert.deepEqual(world.stores[0].untrackedFiles, UNTRACKED);
  assert.ok(world.stores.every(({ token }) => token?.connectionId === 1));
});

test('an active slot run keeps its worktree diff as a query and prefetches only diff paths', async () => {
  const { world, prefetcher } = harness();
  world.runs.set('s1', {
    id: 's1',
    slotId: 'slot-s',
    decisions: [],
    stack: { baseBranch: 'feature/base' },
  } as unknown as Run);
  world.worktree.set('slot-s', {
    diff: [...modified('src/a.ts', A_OLD, A_NEW, A_HUNK), ...added('src/new.ts', ADDED)]
      .concat('')
      .join('\n'),
    mergeBaseSha: BASE,
    headSha: HEAD,
  });
  world.objects.set(
    BASE,
    new Map([
      ['src/a.ts', A_OLD],
      ['.env', 'SECRET=1\n'],
    ]),
  );
  prefetcher.setTargets([target('s1', false)]);
  await flush();
  assert.deepEqual(world.calls, [
    { method: 'run.get', params: { runId: 's1' } },
    {
      method: 'git.diff',
      params: resourceQuery(Methods.GIT_DIFF, {
        slotId: 'slot-s',
        runId: 's1',
        base: 'feature/base',
        target: 'worktree',
        includeUntracked: true,
      }).params,
      placement: { origin: 'prefetch', cohort: 'run' },
    },
    { method: 'git.show', params: { slotId: 'slot-s', ref: BASE, paths: ['src/a.ts'] } },
  ]);
  assert.deepEqual(
    world.stores.map(({ key, cohort }) => [key.id, cohort]),
    [
      [blob(A_OLD), 'run'],
      [blob(A_NEW), 'run'],
      [blob(ADDED), 'run'],
    ],
  );
  assert.ok(!JSON.stringify(world.calls).includes('.env'));
});

test('a frozen review workspace reads its fixed range run-scoped and needs no head check', async () => {
  const { world, prefetcher, change } = harness();
  const diff = [...modified('src/a.ts', A_OLD, A_NEW, A_HUNK), ''].join('\n');
  world.runs.set('f1', {
    id: 'f1',
    slotId: null,
    decisions: [],
    reviewWorkspace: { workspaceId: 'w' },
    reviewWorkspaceSubject: { baseSha: 'b'.repeat(40), headSha: HEAD },
  } as unknown as Run);
  world.frozen.set('f1', { diff, mergeBaseSha: BASE, headSha: HEAD });
  world.objects.set(BASE, new Map([['src/a.ts', A_OLD]]));
  prefetcher.setTargets([target('f1', false)]);
  await flush();
  change({ family: 'package', runId: 'f1' }, { family: 'workspace', slotId: '' });
  await flush();
  assert.deepEqual(world.calls, [
    { method: 'run.get', params: { runId: 'f1' } },
    {
      method: 'git.diff',
      params: { slotId: '', runId: 'f1', base: 'b'.repeat(40), head: HEAD },
    },
    { method: 'git.show', params: { slotId: '', runId: 'f1', ref: BASE, paths: ['src/a.ts'] } },
  ]);
  assert.deepEqual(
    world.stores.map(({ key, cohort }) => [key.kind, key.id, cohort]),
    [
      ['diff', reviewDiffHash(diff), 'run'],
      ['blob', blob(A_OLD), 'run'],
      ['blob', blob(A_NEW), 'run'],
    ],
  );
  assert.equal(world.stores[0].alias, `frozen-diff:f1:${'b'.repeat(40)}:${HEAD}`);
});

test('a package change refetches a gate only for a new package, without held content', async () => {
  const { world, prefetcher, change, calls } = harness();
  world.objects.set(
    BASE,
    new Map([
      ['src/a.ts', A_OLD],
      ['old.txt', GONE],
    ]),
  );
  gateRun(world, 'g1', 'p1', gateDiff());
  prefetcher.setTargets([target('g1', true)]);
  await flush();
  const before = world.calls.length;
  const stored = world.stores.length;
  const reread = deferred();
  world.block = (call) => (call.method === 'run.get' ? reread.promise : undefined);
  change({ family: 'package', runId: 'g1' });
  change({ family: 'package', runId: 'g1' });
  change({ family: 'package', runId: 'g1' });
  await flush();
  assert.equal(world.calls.length, before + 1);
  reread.resolve();
  await flush();
  // One check in flight, then one trailing check; neither finds a new package.
  assert.deepEqual(world.calls.slice(before), [
    { method: 'run.get', params: { runId: 'g1' } },
    { method: 'run.get', params: { runId: 'g1' } },
  ]);
  world.block = () => undefined;
  const fixed = 'one\nTWO\nthree\n';
  const diffHash = gateRun(
    world,
    'g1',
    'p2',
    gateDiff(fixed, ['@@ -1,3 +1,3 @@', ' one', '-two', '+TWO', ' three']),
  );
  change({ family: 'package', runId: 'g1' });
  await flush();
  assert.deepEqual(world.calls.slice(before + 2), [
    { method: 'run.get', params: { runId: 'g1' } },
    {
      method: 'artifact',
      params: { runId: 'g1', path: 'artifacts/p2.diff', bundleDigest: 'bundle-p2' },
    },
    {
      method: 'git.show',
      params: {
        slotId: 'slot-g1',
        ref: BASE,
        paths: ['src/a.ts', 'old.txt'],
        have: [blob(A_OLD), blob(GONE)],
      },
    },
  ]);
  assert.deepEqual(
    world.stores.slice(stored).map(({ key }) => key.id),
    [diffHash, blob(fixed)],
  );
  assert.equal(calls('artifact').filter((call) => call.params.path === 'evidence/a.png').length, 1);
});

test('content held by identity is never transferred again', async () => {
  const first = harness();
  first.world.objects.set(
    BASE,
    new Map([
      ['src/a.ts', A_OLD],
      ['old.txt', GONE],
    ]),
  );
  const diffHash = gateRun(first.world, 'g1', 'p1', gateDiff());
  first.prefetcher.setTargets([target('g1', true)]);
  await flush();
  first.prefetcher.dispose();
  const world = { ...first.world, calls: [], reads: [], retains: [], stores: [] };
  const { prefetcher } = harness(world);
  prefetcher.setTargets([target('g1', true)]);
  await flush();
  assert.deepEqual(world.calls, [
    { method: 'run.get', params: { runId: 'g1' } },
    {
      method: 'git.show',
      params: {
        slotId: 'slot-g1',
        ref: BASE,
        paths: ['src/a.ts', 'old.txt'],
        have: [blob(A_OLD), blob(GONE)],
      },
    },
  ]);
  assert.deepEqual(world.stores, []);
  // Retaining loads no bytes; only the held diff is read, to list its files.
  assert.deepEqual(world.reads, [`diff:${diffHash}`]);
  assert.deepEqual(
    [...world.retains].sort(),
    [
      `diff:${diffHash}`,
      ...[A_OLD, GONE, A_NEW, ADDED, ''].map((text) => `blob:${blob(text)}`),
      `artifact:${sha256(PNG)}`,
    ]
      .map((id) => `${id}:gate`)
      .sort(),
  );
});

test('an active run rereads its diff only when a coalesced git.log reports a new head', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const { world, prefetcher, change, calls } = harness();
  world.runs.set('s1', { id: 's1', slotId: 'slot-s', decisions: [] } as unknown as Run);
  world.worktree.set('slot-s', { diff: '', mergeBaseSha: BASE, headSha: HEAD });
  world.heads.set('slot-s', HEAD);
  prefetcher.setTargets([target('s1', false)]);
  await flush();
  const log = deferred();
  world.block = (call) => (call.method === 'git.log' ? log.promise : undefined);
  change({ family: 'workspace', slotId: 'slot-s', runId: 's1' });
  await flush();
  change({ family: 'workspace', slotId: 'slot-s' }, { family: 'package', runId: 's1' });
  change({ family: 'workspace', slotId: 'other' });
  await flush();
  assert.deepEqual(calls('git.log'), [
    { method: 'git.log', params: { slotId: 'slot-s', limit: 1 } },
  ]);
  log.resolve();
  await flush();
  assert.equal(calls('git.log').length, 1);
  assert.equal(calls('git.diff').length, 1);
  world.block = () => undefined;
  world.heads.set('slot-s', 'd'.repeat(40));
  t.mock.timers.tick(59_999);
  await flush();
  assert.equal(calls('git.log').length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls('git.log').length, 2);
  assert.equal(calls('git.diff').length, 2);
});

test('a slot diff that failed is read again at the next check until it succeeds', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const { world, prefetcher, change, calls } = harness();
  world.runs.set('s1', { id: 's1', slotId: 'slot-s', decisions: [] } as unknown as Run);
  world.worktree.set('slot-s', { diff: '', mergeBaseSha: BASE, headSha: HEAD });
  world.heads.set('slot-s', HEAD);
  // A busy worktree changes under every long diff read.
  world.fail = (call) =>
    call.method === 'git.diff' ? 'RESOURCE_OBSERVATION_UNAVAILABLE' : undefined;
  prefetcher.setTargets([target('s1', false)]);
  await flush();
  assert.equal(calls('git.diff').length, 1);
  change({ family: 'workspace', slotId: 'slot-s' });
  await flush();
  assert.equal(calls('git.log').length, 1);
  assert.equal(calls('git.diff').length, 2, 'the first check tries the unread head');
  change({ family: 'workspace', slotId: 'slot-s' });
  await flush();
  assert.equal(calls('git.diff').length, 2, 'changes within the minute wait for the next check');
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls('git.log').length, 2);
  assert.equal(calls('git.diff').length, 3, 'an unread head is tried again at the next check');

  // The source recovers without a new commit.
  world.fail = () => undefined;
  t.mock.timers.tick(60_000);
  change({ family: 'workspace', slotId: 'slot-s' });
  await flush();
  assert.equal(calls('git.log').length, 3);
  assert.equal(calls('git.diff').length, 4);
  t.mock.timers.tick(60_000);
  change({ family: 'workspace', slotId: 'slot-s' });
  await flush();
  assert.equal(calls('git.log').length, 4);
  assert.equal(calls('git.diff').length, 4, 'a head read successfully is not read again');
});

test('a failed patch or check reads the file by path once and keeps only a matching blob', async () => {
  const { world, prefetcher, calls } = harness();
  const bOld = 'b\n';
  const bNew = 'B\n';
  const diff = [
    ...modified('src/a.ts', A_OLD, A_NEW, A_HUNK),
    // The index claims a new side the hunk does not produce.
    ...modified('src/b.ts', bOld, 'claimed\n', ['@@ -1 +1 @@', '-b', '+B']),
    '',
  ].join('\n');
  world.objects.set(
    BASE,
    new Map([
      ['src/a.ts', 'one\nTWO\nthree\n'],
      ['src/b.ts', bOld],
    ]),
  );
  world.objects.set(
    HEAD,
    new Map([
      ['src/a.ts', A_NEW],
      ['src/b.ts', 'tampered\n'],
    ]),
  );
  gateRun(world, 'g1', 'p1', diff, []);
  prefetcher.setTargets([target('g1', true)]);
  await flush();
  assert.deepEqual(
    calls('git.show')
      .filter((call) => call.params.ref === HEAD)
      .map((call) => call.params),
    [
      { slotId: 'slot-g1', ref: HEAD, paths: ['src/a.ts'] },
      { slotId: 'slot-g1', ref: HEAD, paths: ['src/b.ts'] },
    ],
  );
  const ids = world.stores.map(({ key }) => key.id);
  assert.ok(ids.includes(blob(A_NEW)));
  for (const rejected of [bNew, 'tampered\n', 'claimed\n'])
    assert.ok(!ids.includes(blob(rejected)));
});

test('a new side that is not UTF-8 verifies through the raw bytes of the by-path read', async () => {
  const { world, prefetcher, calls } = harness();
  // ISO-8859-1 text: the diff and both sides carry the byte 0xE9, which is not UTF-8.
  const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0));
  const before = latin1('caf\xe9\n');
  const after = latin1('caf\xe9s\n');
  const diff = [
    'diff --git a/src/l.txt b/src/l.txt',
    `index ${gitBlobHash(before)}..${gitBlobHash(after)} 100644`,
    '--- a/src/l.txt',
    '+++ b/src/l.txt',
    '@@ -1 +1 @@',
    '-caf\xe9',
    '+caf\xe9s',
    '',
  ].join('\n');
  world.objects.set(BASE, new Map([['src/l.txt', before]]));
  world.objects.set(HEAD, new Map([['src/l.txt', after]]));
  gateRun(world, 'g1', 'p1', new TextDecoder().decode(latin1(diff)), []);
  world.artifacts.set('artifacts/p1.diff', latin1(diff));
  prefetcher.setTargets([target('g1', true)]);
  await flush();
  assert.deepEqual(
    calls('git.show').map((call) => call.params),
    [
      { slotId: 'slot-g1', ref: BASE, paths: ['src/l.txt'] },
      { slotId: 'slot-g1', ref: HEAD, paths: ['src/l.txt'] },
    ],
  );
  const stored = world.stores.find(({ key }) => key.id === gitBlobHash(after));
  assert.deepEqual(stored?.data, after);
});

test('without capabilities.batchedContent nothing is read until the gateway offers it', async () => {
  const { world, prefetcher, connect } = harness(createWorld(), {
    ...BATCHED,
    batchedContent: false,
  });
  world.runs.set('g1', { id: 'g1', slotId: null, decisions: [] } as unknown as Run);
  prefetcher.setTargets([target('g1', true)]);
  await flush();
  connect({ connected: false, capabilities: BATCHED });
  await flush();
  assert.deepEqual(world.calls, []);
  connect({ connected: true });
  await flush();
  assert.deepEqual(world.calls, [{ method: 'run.get', params: { runId: 'g1' } }]);
});

test('a refused store stops only that run, without retrying', async () => {
  const { world, prefetcher, calls } = harness();
  world.pageSize = 1;
  world.objects.set(
    BASE,
    new Map([
      ['src/a.ts', A_OLD],
      ['old.txt', GONE],
      ['src/s.ts', 's\n'],
    ]),
  );
  gateRun(world, 'g1', 'p1', gateDiff());
  world.runs.set('s1', { id: 's1', slotId: 'slot-s', decisions: [] } as unknown as Run);
  world.worktree.set('slot-s', {
    diff: [...modified('src/s.ts', 's\n', 'S\n', ['@@ -1 +1 @@', '-s', '+S']), ''].join('\n'),
    mergeBaseSha: BASE,
    headSha: HEAD,
  });
  world.refuseStore = (input) => input.key.id === blob(A_OLD);
  prefetcher.setTargets([target('g1', true), target('s1', false)]);
  await flush();
  // The two runs interleave, so compare what each did rather than the global order.
  assert.deepEqual(
    calls('git.show')
      .map((call) => JSON.stringify(call.params.paths))
      .sort(),
    ['["src/a.ts","old.txt"]', '["src/s.ts"]'],
  );
  assert.deepEqual(
    world.stores
      .filter(({ key }) => key.kind === 'blob')
      .map(({ key }) => key.id)
      .sort(),
    [blob(A_OLD), blob('s\n'), blob('S\n')].sort(),
  );
  assert.equal(calls('artifact').length, 1);
});

test('observed git.diff accepts includeUntracked only for a worktree diff, false as absent', () => {
  const worktree = { slotId: 'slot', runId: 'run', base: 'main', target: 'worktree' };
  const untracked = resourceQuery(Methods.GIT_DIFF, { ...worktree, includeUntracked: true });
  assert.deepEqual(untracked.params, { ...worktree, includeUntracked: true });
  assert.notEqual(untracked.id, resourceQuery(Methods.GIT_DIFF, worktree).id);
  assert.equal(
    resourceQuery(Methods.GIT_DIFF, { ...worktree, includeUntracked: false }).id,
    resourceQuery(Methods.GIT_DIFF, worktree).id,
  );
  assert.throws(
    () => resourceQuery(Methods.GIT_DIFF, { slotId: 'slot', includeUntracked: true }),
    /worktree/,
  );
  assert.throws(
    () => resourceQuery(Methods.GIT_DIFF, { ...worktree, includeUntracked: 'yes' }),
    /boolean/,
  );
});

/** The prefetcher over the real cache and memory store, so budgets and eviction are the cache's. */
function realCache(
  world: World,
  contentBudgetBytes: number,
  store: ResourceStore = createMemoryResourceStore(),
) {
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://prefetch.invalid/', principalId: 'owner', principalGeneration: 0 },
    authority: { roles: [{ role: 'admin', scope: { kind: 'global' } }], workspaceAccess: 'farm' },
    capabilities: {
      ...BATCHED,
      resourceChanges: {
        version: 1,
        epoch: 'epoch',
        versionLists: false,
        observedReads: 1,
        workspaceReads: 1,
      },
    },
  };
  const transport: ResourceCacheTransport = {
    getConnection: () => connection,
    onConnectionChange: () => () => {},
    onResourceChanged: () => () => {},
    async request<T>(method: string, params: unknown) {
      const value = params as Record<string, unknown>;
      world.calls.push({ method, params: value });
      const code = world.fail({ method, params: value });
      if (code) throw Object.assign(new Error(code), { code });
      const data =
        method === Methods.RUN_GET
          ? { run: world.runs.get(String(value.runId)) }
          : world.worktree.get(String(value.slotId));
      return { data: data as T };
    },
    resynchronize: () => {},
  };
  const cache = createGatewayResourceCache({ transport, store, contentBudgetBytes });
  const { request, readArtifact } = gateway(world);
  const prefetcher = createContentPrefetcher({ transport, cache, request, readArtifact });
  /** Rows inside the content budget: content and workspace snapshots, which carry an origin. */
  const rows = async () =>
    [...(await store.listContent()), ...(await store.listQueries())].filter((row) => row.origin);
  return { cache, store, prefetcher, rows };
}

function worktreeRun(world: World, runId: string, slotId: string, diff: string) {
  world.runs.set(runId, { id: runId, slotId, decisions: [] } as unknown as Run);
  world.worktree.set(slotId, { diff, mergeBaseSha: BASE, headSha: HEAD });
}

test('real cache: a slot diff snapshot is prefetch and never evicts opened content', async () => {
  const world = createWorld();
  world.objects.set(BASE, new Map([['src/a.ts', A_OLD]]));
  worktreeRun(
    world,
    's1',
    'slot-s',
    [...modified('src/a.ts', A_OLD, A_NEW, A_HUNK), ''].join('\n'),
  );
  const { cache, store, prefetcher, rows } = realCache(world, 2000);
  // The snapshot fits only by evicting the opened file; the base files fit beside it.
  const snapshot = bytes(JSON.stringify(world.worktree.get('slot-s'))).byteLength;
  const opened = bytes(`${'o'.repeat(2000 - snapshot + 49)}\n`);
  const openedKey: ContentKey = { kind: 'blob', id: gitBlobHash(opened) };
  assert.equal(
    await cache.storeContent({ key: openedKey, data: opened, origin: 'opened', cohort: 'run' }),
    true,
  );
  prefetcher.setTargets([target('s1', false)]);
  await flush();
  assert.ok((await store.listQueries()).every((row) => !row.id.startsWith(`${Methods.GIT_DIFF}:`)));
  assert.deepEqual(await cache.readContent(openedKey), opened);
  assert.deepEqual(
    (await rows())
      .filter((row) => 'kind' in row)
      .map((row) => [row.id, row.origin])
      .sort(),
    [
      [openedKey.id, 'opened'],
      [blob(A_OLD), 'prefetch'],
      [blob(A_NEW), 'prefetch'],
    ].sort(),
  );
  prefetcher.dispose();
  await cache.dispose();
});

test('real cache: a prefetch refresh of an opened snapshot evicts only what prefetch may', async () => {
  const world = createWorld();
  world.worktree.set('slot-s', { diff: '', mergeBaseSha: BASE, headSha: HEAD });
  const budget = 4000;
  const { cache, store, prefetcher } = realCache(world, budget);
  const query = activeRunDiffQuery({ slotId: 'slot-s', runId: 's1', base: 'main' });
  // The user opens the snapshot, so its row is opened.
  const stop = cache.observe(query, () => {});
  await flush();
  stop();
  const opened = (await store.getQuery(query.id))!;
  assert.equal(opened.origin, undefined);
  // A refresh that fits only by evicting an opened file.
  const refreshed = { diff: 'x'.repeat(1500), mergeBaseSha: BASE, headSha: HEAD };
  const file = bytes(`${'o'.repeat(budget - bytes(JSON.stringify(refreshed)).byteLength + 99)}\n`);
  const key: ContentKey = { kind: 'blob', id: gitBlobHash(file) };
  assert.equal(
    await cache.storeContent({ key, data: file, origin: 'opened', cohort: 'run' }),
    true,
  );
  world.worktree.set('slot-s', refreshed);
  await cache.retry(query, { origin: 'prefetch', cohort: 'run' });
  await flush();
  assert.deepEqual(await cache.readContent(key), file);
  assert.deepEqual(await store.getQuery(query.id), opened);

  // With room, the refresh is stored and its row stays opened.
  await store.deleteContent(key);
  await cache.retry(query, { origin: 'prefetch', cohort: 'run' });
  await flush();
  const stored = (await store.getQuery(query.id))!;
  assert.deepEqual([stored.data, stored.origin], [refreshed, undefined]);
  prefetcher.dispose();
  await cache.dispose();
});

test('real cache: gate prefetch promotes held run content, which run prefetch cannot evict', async () => {
  const world = createWorld();
  world.objects.set(BASE, new Map([['src/a.ts', A_OLD]]));
  const diff = [...modified('src/a.ts', A_OLD, A_NEW, A_HUNK), ''].join('\n');
  worktreeRun(world, 'r1', 'slot-r1', diff);
  const budget = 8000;
  const { cache, prefetcher, rows } = realCache(world, budget);
  prefetcher.setTargets([target('r1', false)]);
  await flush();
  const cohorts = async () =>
    Object.fromEntries((await rows()).map((row) => [row.id, `${row.origin}/${row.cohort}`]));
  const diffSnapshot = resourceQuery(Methods.GIT_DIFF, {
    slotId: 'slot-r1',
    runId: 'r1',
    base: 'main',
    target: 'worktree',
    includeUntracked: true,
  }).id;
  assert.deepEqual(await cohorts(), {
    [blob(A_OLD)]: 'prefetch/run',
    [blob(A_NEW)]: 'prefetch/run',
    [diffSnapshot]: 'prefetch/run',
  });

  // The run reaches its gate: the same change, now as a retained package.
  const diffHash = gateRun(world, 'r1', 'p1', diff, []);
  world.runs.get('r1')!.slotId = 'slot-r1';
  world.calls.length = 0;
  prefetcher.setTargets([target('r1', true)]);
  await flush();
  assert.deepEqual(
    world.calls.filter((call) => call.method === Methods.GIT_SHOW).map((call) => call.params),
    [{ slotId: 'slot-r1', ref: BASE, paths: ['src/a.ts'], have: [blob(A_OLD)] }],
  );
  const promoted = await cohorts();
  assert.equal(promoted[blob(A_OLD)], 'prefetch/gate');
  assert.equal(promoted[blob(A_NEW)], 'prefetch/gate');
  assert.equal(promoted[diffHash], 'prefetch/gate');

  // A later active run needs more than the prefetch half once the run snapshot is gone, so it
  // is refused rather than evicting the gate's files.
  const gateBytes = (await rows())
    .filter((row) => row.origin === 'prefetch' && row.cohort === 'gate')
    .reduce((sum, row) => sum + row.bytes, 0);
  const lines = Math.ceil((budget / 2 - gateBytes + 1) / 11);
  const big = 'abcdefghij\n'.repeat(lines);
  world.objects.get(BASE)!.set('big.txt', big);
  worktreeRun(
    world,
    'r2',
    'slot-r2',
    [
      ...modified('big.txt', big, `${big}tail\n`, [
        `@@ -${lines - 2},3 +${lines - 2},4 @@`,
        ...Array.from({ length: 3 }, () => ' abcdefghij'),
        '+tail',
      ]),
      '',
    ].join('\n'),
  );
  prefetcher.setTargets([target('r1', true), target('r2', false)]);
  await flush();
  const after = await cohorts();
  assert.equal(after[blob(big)], undefined);
  for (const id of [blob(A_OLD), blob(A_NEW), diffHash]) assert.equal(after[id], 'prefetch/gate');
  prefetcher.dispose();
  await cache.dispose();
});

test('real cache: a refusal cancels a run read still waiting inside the cache', async () => {
  const world = createWorld();
  for (const runId of ['g1', 'r2'])
    world.runs.set(runId, { id: runId, slotId: null, decisions: [] } as unknown as Run);
  world.fail = (call) => (call.params.runId === 'g1' ? 'AUTH_FORBIDDEN' : undefined);
  // The second run's stored result is still loading when the first run is refused.
  const store = createMemoryResourceStore();
  const getQuery = store.getQuery.bind(store);
  const loading = deferred();
  store.getQuery = async <T>(id: string) => {
    if (id.includes('"r2"')) await loading.promise;
    return getQuery<T>(id);
  };
  const { cache, prefetcher } = realCache(world, 8000, store);
  prefetcher.setTargets([target('g1', true), target('r2', false)]);
  await flush();
  assert.deepEqual(world.calls, [{ method: 'run.get', params: { runId: 'g1' } }]);
  loading.resolve();
  await flush();
  assert.deepEqual(world.calls, [{ method: 'run.get', params: { runId: 'g1' } }]);
  prefetcher.dispose();
  await cache.dispose();
});

test('real cache: a refusal stops prefetch before its eviction write lets another read go', async () => {
  const world = createWorld();
  for (const runId of ['g1', 'r2'])
    world.runs.set(runId, { id: runId, slotId: null, decisions: [] } as unknown as Run);
  world.fail = (call) => (call.params.runId === 'g1' ? 'AUTH_FORBIDDEN' : undefined);
  const store = createMemoryResourceStore();
  const refused = resourceQuery(Methods.RUN_GET, { runId: 'g1' }).id;
  await store.putQuery({ id: refused, data: { run: { id: 'g1' } }, observedAt: 1, bytes: 1 });
  // The refused result's eviction is still being written when the second run's load completes.
  const evicting = deferred();
  const loading = deferred();
  const deleteQuery = store.deleteQuery.bind(store);
  store.deleteQuery = async (id) => {
    if (id === refused) await evicting.promise;
    return deleteQuery(id);
  };
  const getQuery = store.getQuery.bind(store);
  store.getQuery = async <T>(id: string) => {
    if (id.includes('"r2"')) await loading.promise;
    return getQuery<T>(id);
  };
  const { cache, prefetcher } = realCache(world, 8000, store);
  prefetcher.setTargets([target('g1', true), target('r2', false)]);
  await flush();
  loading.resolve();
  await flush();
  assert.deepEqual(world.calls, [{ method: 'run.get', params: { runId: 'g1' } }]);
  evicting.resolve();
  await flush();
  assert.equal(await store.getQuery(refused), undefined);
  assert.deepEqual(world.calls, [{ method: 'run.get', params: { runId: 'g1' } }]);
  prefetcher.dispose();
  await cache.dispose();
});

test('real cache: an aborted retry writes no result unless another caller shares its read', async () => {
  const transport = new ResourceCacheConformanceTransport({
    gatewayUrl: 'ws://prefetch.invalid/',
    principalId: 'owner',
    principalGeneration: 0,
  });
  transport.setConnection({ connected: true, id: 1 });
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  const query = resourceQuery(Methods.RUN_GET, { runId: 'x' });
  const alone = new AbortController();
  const cancelled = cache.retry(query, undefined, alone.signal);
  const first = await transport.nextRead();
  alone.abort();
  assert.equal(first.signal.aborted, true);
  first.resolve({ value: 'first' });
  await cancelled;
  assert.equal(await store.getQuery(query.id), undefined);

  const joined = new AbortController();
  const started = cache.retry(query, undefined, joined.signal);
  const second = await transport.nextRead();
  const sharing = cache.retry(query);
  await flush();
  joined.abort();
  assert.equal(second.signal.aborted, false);
  second.resolve({ value: 'second' });
  await Promise.all([started, sharing]);
  assert.deepEqual((await store.getQuery(query.id))?.data, { value: 'second' });
  await cache.dispose();
});

test('activeRunDiffBase takes the stack base, then the project default branch, then main', () => {
  const stacked = { stack: { baseBranch: 'feature/base', retargetedTo: 'develop' } } as Run;
  const trunk = () => 'trunk';
  assert.equal(activeRunDiffBase(stacked, trunk), 'develop');
  assert.equal(
    activeRunDiffBase({ stack: { baseBranch: 'feature/base' } } as Run, trunk),
    'feature/base',
  );
  assert.equal(activeRunDiffBase({} as Run, trunk), 'trunk');
  assert.equal(activeRunDiffBase({} as Run), 'main');
  assert.equal(
    activeRunDiffBase({} as Run, () => undefined),
    'main',
  );
});

test('an active run without a stack base is compared with its project default branch', async () => {
  const { world, prefetcher, calls } = harness(createWorld(), BATCHED, (run) =>
    run.project === 'farm' ? 'trunk' : undefined,
  );
  world.runs.set('s1', {
    id: 's1',
    slotId: 'slot-s',
    project: 'farm',
    decisions: [],
  } as unknown as Run);
  world.worktree.set('slot-s', { diff: '', mergeBaseSha: BASE, headSha: HEAD });
  prefetcher.setTargets([target('s1', false)]);
  await flush();
  assert.deepEqual(
    calls('git.diff').map((call) => call.params),
    [activeRunDiffQuery({ slotId: 'slot-s', runId: 's1', base: 'trunk' }).params],
  );
});
