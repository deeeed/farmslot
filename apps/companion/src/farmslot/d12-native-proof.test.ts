import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { mock } from 'node:test';

import {
  HUMAN_GATE_DECISION_TYPE,
  Methods,
  reviewDiffHash,
  reviewSnapshotIdentityText,
} from '@farmslot/protocol';
import {
  type ContentKey,
  gitBlobHash,
  resourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { createOfflineClientStoreBaseline } from '../lib/offline-client-store-baseline';

const bytes = (text: string) => new TextEncoder().encode(text);
const blob = (text: string) => gitBlobHash(bytes(text));
const OLD = 'one\ntwo\n';
const NEW = 'one\n2\n';
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
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 7, 8, 9]);
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');
const run = {
  id: 'run-gate',
  slotId: 'slot-gate',
  decisions: [
    {
      id: 'gate-1',
      type: HUMAN_GATE_DECISION_TYPE,
      payload: {
        kind: 'ready',
        prPackage: {
          id: 'package-1',
          reviewSnapshot: {
            source: 'local-git',
            diffPath: 'review/package.diff',
            diffHash: DIFF_HASH,
            capturedAt: '2026-10-28T00:00:00.000Z',
          },
          evidenceManifest: [
            { path: 'evidence/after.png', purpose: 'screenshot', sha256: PNG_SHA },
            { path: 'evidence/log.txt', purpose: 'log', sha256: 'f'.repeat(64) },
          ],
        },
      },
    },
  ],
};

function world() {
  const states = new Map<string, ResourceQueryState<unknown>>([
    [
      resourceQuery(Methods.DECISION_LIST).id,
      {
        status: 'stale',
        data: {
          decisions: [
            {
              id: 'gate-1',
              type: HUMAN_GATE_DECISION_TYPE,
              runMeta: { runId: 'run-gate' },
              payload: { kind: 'ready' },
            },
          ],
        },
      },
    ],
    [resourceQuery(Methods.RUN_GET, { runId: 'run-gate' }).id, { status: 'stale', data: { run } }],
    [
      resourceQuery(Methods.RUNNER_VISIBLE_MODELS_GET, {}, 'owner').id,
      { status: 'stale', data: { runners: [{ runner: 'codex' }, { runner: 'cursor' }] } },
    ],
    [
      resourceQuery(Methods.RUNNER_MODEL_CATALOG, { runner: 'codex' }).id,
      { status: 'stale', data: { models: [{ id: 'gpt-b' }, { id: 'gpt-a' }] } },
    ],
    [
      resourceQuery(Methods.RUNNER_MODEL_CATALOG, { runner: 'cursor' }).id,
      { status: 'stale', data: { models: [{ id: 'gpt-a' }, { id: 'sonnet' }] } },
    ],
    [
      resourceQuery(Methods.PR_LIST).id,
      {
        status: 'stale',
        observedAt: 5,
        sourceObservation: { status: 'ready', observedAt: 42 },
        data: { prs: [{ pr: 7 }, { pr: 9 }] },
      },
    ],
  ]);
  const content = new Map<string, Uint8Array>([
    [`diff:${DIFF_HASH}`, bytes(DIFF)],
    [`blob:${blob(OLD)}`, bytes(OLD)],
    [`blob:${blob(NEW)}`, bytes(NEW)],
    [`artifact:${PNG_SHA}`, PNG],
  ]);
  const id = (key: ContentKey) => `${key.kind}:${key.id}`;
  const cache = {
    read: (query: { id: string }) => states.get(query.id) ?? { status: 'loading' },
    hasContent: async (key: ContentKey) => content.has(id(key)),
    readContent: async (key: ContentKey) => content.get(id(key)),
  } as never;
  return { cache, content };
}

let connection = { status: 'disconnected', client: undefined as unknown };
mock.module('../store/connection', {
  namedExports: { useConnectionStore: { getState: () => connection } },
});
mock.module('../lib/resource-cache', {
  namedExports: { getResourceCache: () => undefined, getResourceNativeOwnerId: () => undefined },
});
// Loaded after the mocks; this package compiles to CJS, so no top-level await.
const load = () => import('./d12-native-proof');

const inputs = (cache: never, ready = true) => ({
  status: 'disconnected',
  launchId: 'launch-1',
  epoch: 'epoch-1',
  connectionId: 2,
  framesSent: 0,
  cache,
  owner: 'owner',
  gateScreens: [{ decisionId: 'gate-1', ready, details: ready }],
  diffScreens: [{ runId: 'run-gate', packageDiff: true }],
  images: [{ id: PNG_SHA, state: 'loaded' as const, mountId: 3 }],
  image: { id: PNG_SHA, state: 'loaded' as const, mountId: 3 },
});

test('the d12-native observation reports the gate, catalog, upstream and image the screens show', async () => {
  const proof = await load();
  const { cache } = world();
  assert.deepEqual(await proof.d12NativeObservation(inputs(cache)), {
    status: 'disconnected',
    launchId: 'launch-1',
    epoch: 'epoch-1',
    connectionId: 2,
    framesSent: 0,
    gate: {
      decisionId: 'gate-1',
      packageHeld: true,
      opened: true,
      details: true,
      diff: true,
      images: [{ sha256: PNG_SHA, loaded: true }],
      held: { diff: true, bothSides: true, images: [{ sha256: PNG_SHA, verified: true }] },
    },
    catalog: { models: ['gpt-a', 'gpt-b', 'sonnet'] },
    upstream: {
      prs: [
        { number: 7, observedAt: 42 },
        { number: 9, observedAt: 42 },
      ],
    },
    image: { id: PNG_SHA, state: 'loaded', mountId: 3 },
    imageMounts: [{ id: PNG_SHA, state: 'loaded', mountId: 3 }],
    lastMounted: undefined,
    lastFailed: undefined,
  });
});

test('missing or wrong held content and an unopened screen are reported, never assumed', async () => {
  const proof = await load();
  const { cache, content } = world();
  content.delete(`blob:${blob(OLD)}`);
  content.set(`artifact:${PNG_SHA}`, new Uint8Array([1, 2, 3]));
  const gate = (await proof.d12NativeObservation(inputs(cache, false))).gate!;
  assert.equal(gate.opened, false);
  assert.equal(gate.details, false);
  assert.equal(gate.held.bothSides, false, 'a base blob is missing');
  assert.deepEqual(gate.held.images, [{ sha256: PNG_SHA, verified: false }]);
  content.delete(`diff:${DIFF_HASH}`);
  const empty = (await proof.d12NativeObservation(inputs(cache))).gate!;
  assert.equal(empty.packageHeld, false);
  assert.equal(empty.held.diff, false);
  assert.equal(empty.held.bothSides, false);
  const none = await proof.d12NativeObservation({ ...inputs(cache), cache: undefined as never });
  assert.equal(none.gate, undefined);
  assert.deepEqual(none.catalog, { models: [] });
});

test('held bytes alone never claim a rendered gate: the diff screen and each image load must report it', async () => {
  const proof = await load();
  const { cache } = world();
  const unrendered = {
    ...inputs(cache),
    diffScreens: [],
    images: [],
  };
  const gate = (await proof.d12NativeObservation(unrendered)).gate!;
  assert.deepEqual(gate.held, {
    diff: true,
    bothSides: true,
    images: [{ sha256: PNG_SHA, verified: true }],
  });
  assert.equal(gate.diff, false, 'no Diff screen rendered the package diff');
  assert.deepEqual(gate.images, [{ sha256: PNG_SHA, loaded: false }]);
  const otherRun = { ...unrendered, diffScreens: [{ runId: 'run-other', packageDiff: true }] };
  assert.equal((await proof.d12NativeObservation(otherRun)).gate!.diff, false);
  const failedMount = {
    ...unrendered,
    images: [
      { id: PNG_SHA, state: 'loaded' as const, mountId: 3 },
      { id: PNG_SHA, state: 'failed' as const, mountId: 4 },
    ],
  };
  assert.deepEqual((await proof.d12NativeObservation(failedMount)).gate!.images, [
    { sha256: PNG_SHA, loaded: false },
  ]);
});

test('the observer reports the image that failed until that same mount loads, and counts sent frames', async () => {
  const proof = await load();
  const meter = createOfflineClientStoreBaseline(() => {});
  connection = { status: 'connected', client: { offlineBaseline: meter } };
  meter.sent({ type: 'req', id: '1', method: 'run.get', params: { runId: 'a' } });
  proof.reportArtifactImage({ id: 'other', state: 'loaded', mountId: 1 });
  proof.reportArtifactImage({ id: PNG_SHA, state: 'failed', mountId: 2 });
  proof.reportArtifactImage({ id: 'later', state: 'loading', mountId: 3 });
  const read = async (ref = 'd12-native') =>
    (await proof.observeD12Native(ref)).observations.d12Native;
  const failed = await read();
  assert.deepEqual(failed.image, { id: PNG_SHA, state: 'failed', mountId: 2 });
  assert.equal(failed.framesSent, 1);
  assert.equal(typeof failed.launchId, 'string');
  proof.reportArtifactImage({ id: PNG_SHA, state: 'loaded', mountId: 2 });
  assert.deepEqual((await read()).image, { id: PNG_SHA, state: 'loaded', mountId: 2 });
  assert.equal((await read('d12-native:reset')).framesSent, 0);
  assert.equal((await read()).launchId, failed.launchId, 'one launch id per process');
  proof.forgetArtifactImage(2);
  assert.equal((await read()).image?.mountId, 3);
});

test('each mount reports its reads: stage, effect runs, fetch outcome, result time and report order', async () => {
  const proof = await load();
  const meter = createOfflineClientStoreBaseline(() => {});
  connection = { status: 'connected', client: { offlineBaseline: meter } };
  proof.reportArtifactImage({
    id: 'big',
    path: 'a.png',
    state: 'loading',
    mountId: 40,
    read: 'reading',
  });
  proof.traceArtifactImage(40, 1, 'open-held');
  proof.traceArtifactImage(40, 1, 'fetch');
  proof.traceArtifactImage(40, 1, 'fetch', { error: 'HTTP 503' });
  proof.traceArtifactImage(40, 1, 'committed');
  proof.traceArtifactImage(40, 2, 'open-held');
  proof.traceArtifactImage(40, 2, 'fetch');
  proof.traceArtifactImage(40, 2, 'fetch', { bytes: 2_621_440 });
  // The first read's late events arrive after the second read began; they are ignored.
  proof.traceArtifactImage(40, 1, 'aborted');
  proof.traceArtifactImage(40, 1, 'fetch', { error: 'late' });
  // A mount that traced a read but never reported still shows.
  proof.traceArtifactImage(41, 1, 'open-held');
  proof.traceArtifactImage(41, 1, 'store');
  const observed = (await proof.observeD12Native('d12-native')).observations.d12Native;
  const big = observed.imageMounts.find((frame) => frame.mountId === 40)!;
  assert.equal(big.path, 'a.png');
  assert.equal(big.read, 'reading');
  assert.equal(big.stage, 'fetch');
  assert.equal(big.effectRuns, 2);
  assert.deepEqual({ ...big.fetch, at: 0 }, { bytes: 2_621_440, run: 2, at: 0 });
  assert.equal(typeof big.lastResultAt, 'number', 'the first read committed a result');
  assert(big.firstReport! >= 1);
  assert.equal(observed.lastMounted, 40);
  const unreported = observed.imageMounts.find((frame) => frame.mountId === 41)!;
  assert.equal(unreported.id, '', 'never reported');
  assert.equal(unreported.firstReport, undefined);
  assert.equal(unreported.stage, 'store');
  assert.equal(unreported.effectRuns, 1);
  proof.forgetArtifactImage(40);
  proof.forgetArtifactImage(41);
  const after = (await proof.observeD12Native('d12-native')).observations.d12Native.imageMounts;
  assert.equal(
    after.some((frame) => frame.mountId === 40 || frame.mountId === 41),
    false,
  );
});

test('an image unmounted mid-fetch stays gone when its aborted read reports late', async () => {
  const proof = await load();
  connection = { status: 'connected', client: { offlineBaseline: undefined } };
  proof.reportArtifactImage({ id: 'gone', state: 'loading', mountId: 50, read: 'reading' });
  proof.traceArtifactImage(50, 1, 'open-held');
  proof.traceArtifactImage(50, 1, 'fetch');
  proof.traceArtifactImage(50, 1, 'aborted');
  proof.forgetArtifactImage(50);
  // The aborted fetch's rejection and the read's result arrive after the unmount.
  proof.traceArtifactImage(50, 1, 'fetch', { error: 'Aborted' });
  proof.traceArtifactImage(50, 1, 'committed');
  const observed = (await proof.observeD12Native('d12-native')).observations.d12Native;
  assert.equal(
    observed.imageMounts.some((frame) => frame.mountId === 50),
    false,
  );
});

test('report order keeps counting after a mount is forgotten', async () => {
  const proof = await load();
  connection = { status: 'connected', client: { offlineBaseline: undefined } };
  proof.reportArtifactImage({ id: 'first', state: 'loading', mountId: 60 });
  proof.reportArtifactImage({ id: 'second', state: 'loading', mountId: 61 });
  proof.forgetArtifactImage(60);
  proof.reportArtifactImage({ id: 'third', state: 'loading', mountId: 62 });
  const mounts = (await proof.observeD12Native('d12-native')).observations.d12Native.imageMounts;
  const order = (mountId: number) => mounts.find((frame) => frame.mountId === mountId)?.firstReport;
  assert(order(62)! > order(61)!, 'a later mount reports after an earlier one');
  proof.forgetArtifactImage(61);
  proof.forgetArtifactImage(62);
});
