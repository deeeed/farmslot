import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';

import { type ReadyGatePayload, reviewDiffHash, type RunDecision } from '@farmslot/protocol';
import {
  type ContentKey,
  createGatewayResourceCache,
  createMemoryResourceStore,
  type GatewayResourceCache,
  gitBlobHash,
  type ResourceCacheConnection,
  type ResourceStore,
} from '@farmslot/protocol/client-cache';

import { FakeControllerHost } from '../../testing/fake-controller-host.js';
import { DiffTestFilterController } from '../shared/diff-test-filter-controller.js';

const gateway = {
  connectionState: 'disconnected' as 'connected' | 'disconnected',
  connectionEpoch: 1,
  resourceConnectionId: 1,
  onConnectionChange: () => () => undefined,
  request: async (method: string) => assert.fail(`No gateway command expected (${method})`),
};
mock.module('../../gateway-client.js', { namedExports: { gateway } });

let cache: GatewayResourceCache | undefined;
mock.module('../../resource-cache.js', {
  namedExports: {
    getResourceCache: () => cache,
    getResourceNativeOwnerId: () => 'operator',
    getResourceStoreMetadata: () => undefined,
    getResourceStoreNotice: () => undefined,
    getResourceWorkspaceAccess: () => 'farm',
    getResourceWorkspaceKey: () => 'operator',
    initializeResourceCache: () => undefined,
    disposeResourceCache: async () => undefined,
    setContentPrefetchTargets: () => undefined,
    subscribeResourceCache: () => () => undefined,
  },
});

// The import graph reads `location` at module load (global filters).
Object.defineProperty(globalThis, 'location', {
  configurable: true,
  value: new URL('http://localhost:7777/'),
});

const { ReadyWorkspaceActionPresenter } = await import('./ready-workspace-action-presenter.js');
const { heldBlobId, openHeldText } = await import('../../held-content.js');
const { loadGatewayMedia } = await import('../shared/gateway-media-src.js');
const { clearGatewayMemoryAuth, setGatewayMemoryAuth } = await import('../../gateway-url.js');

type Presenter = InstanceType<typeof ReadyWorkspaceActionPresenter>;

const encoder = new TextEncoder();
const baseFile = 'export const gate = 1;\n';
const headFile = 'export const gate = 2;\n';
const addedFile = 'export const added = true;\n';
const baseId = gitBlobHash(encoder.encode(baseFile));
const headId = gitBlobHash(encoder.encode(headFile));
const addedId = gitBlobHash(encoder.encode(addedFile));
const changedSection = `diff --git a/src/gate.ts b/src/gate.ts
index ${baseId}..${headId} 100644
--- a/src/gate.ts
+++ b/src/gate.ts
@@ -1 +1 @@
-export const gate = 1;
+export const gate = 2;`;
const addedSection = `diff --git a/src/added.ts b/src/added.ts
new file mode 100644
index ${'0'.repeat(40)}..${addedId}
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1 @@
+export const added = true;`;
const packageDiff = `${changedSection}\n${addedSection}\n`;
const diffKey: ContentKey = { kind: 'diff', id: reviewDiffHash(packageDiff) };
const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const imageSha = createHash('sha256').update(image).digest('hex');
const imageArtifact = { path: 'evidence/after.png', sha256: imageSha, sizeBytes: image.length };

const decision = {
  id: 'gate',
  type: 'engine_human_gate',
  title: 'Ready',
  description: '',
  actions: [],
  createdAt: '2026-10-27T00:00:00.000Z',
  payload: {
    kind: 'ready',
    prPackage: {
      id: 'package',
      packageHash: 'package-hash',
      artifactBundle: { bundleDigest: 'bundle' },
      evidenceManifest: [imageArtifact],
      reviewSnapshot: {
        diffHash: diffKey.id,
        diffPath: 'artifacts/package.diff',
        source: 'local-git',
        capturedAt: '2026-10-27T00:00:00.000Z',
      },
    },
  } as unknown as ReadyGatePayload,
} as RunDecision;

const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

function openCache(t: import('node:test').TestContext) {
  const listeners = new Set<(next: ResourceCacheConnection) => void>();
  let connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'none',
    scope: { gatewayUrl: 'ws://localhost:7777/ws' },
  };
  const store: ResourceStore = createMemoryResourceStore();
  const owned = createGatewayResourceCache({
    store,
    transport: {
      getConnection: () => connection,
      onConnectionChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onResourceChanged: () => () => {},
      resynchronize() {},
      request: () => new Promise(() => {}),
    },
  });
  cache = owned;
  t.after(async () => {
    await owned.dispose();
    cache = undefined;
  });
  return {
    store,
    cache: owned,
    origins: async () =>
      Object.fromEntries((await store.listContent()).map((row) => [row.id, row.origin])),
    goOffline() {
      connection = { ...connection, connected: false };
      gateway.connectionState = 'disconnected';
      for (const listener of listeners) listener(connection);
    },
  };
}

function makePresenter(): Presenter {
  const view = Object.create(ReadyWorkspaceActionPresenter.prototype) as Presenter;
  Object.assign(view, {
    requestUpdate: () => undefined,
    _syncViewStateToHash: () => undefined,
    runId: 'gate-run',
    slotId: 'slot-a',
    decision,
    _recoveryEpoch: 0,
    _recoveryPhase: 'live',
    _diffFiles: [],
    _selectedFile: '',
    _fileDiff: '',
    _fileDiffLoading: false,
    _diffError: '',
    _diffModalOpen: false,
    _diffModalText: '',
    _diffModalUrl: '',
    _diffModalArtifactPath: '',
    _queries: {
      get decision() {
        return decision;
      },
      ready: false,
      sync: () => undefined,
      capture: () => ({
        current: () => gateway.connectionState === 'connected',
        ownsView: () => true,
      }),
    },
    _reads: {
      read: async () => assert.fail('The slot is unreachable; its diff is not read'),
      releaseMethods: () => undefined,
      clear: () => undefined,
    },
  });
  Object.defineProperty(view, '_usesMockData', { value: false });
  Object.assign(view, {
    _testFilter: new DiffTestFilterController(new FakeControllerHost(), {
      patterns: () => null,
      onChange: () => undefined,
    }),
  });
  return view;
}

test('a prefetched gate opens offline: its diff, both sides of each file and its evidence images', async (t) => {
  gateway.connectionState = 'connected';
  const fixture = openCache(t);
  const prefetch = (key: ContentKey, data: Uint8Array | string) =>
    fixture.cache.storeContent({
      key,
      data: typeof data === 'string' ? encoder.encode(data) : data,
      origin: 'prefetch',
      cohort: 'gate',
    });
  assert.equal(await prefetch(diffKey, packageDiff), true);
  assert.equal(await prefetch({ kind: 'blob', id: baseId }, baseFile), true);
  assert.equal(await prefetch({ kind: 'blob', id: headId }, headFile), true);
  assert.equal(await prefetch({ kind: 'artifact', id: imageSha }, image), true);
  fixture.goOffline();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Offline gates read held bytes'));

  const view = makePresenter();
  await view._beginRecovery();
  await flush();
  assert.equal(view._recoveryPhase, 'stale');
  assert.equal(view._isRecovering, true, 'actions wait for the gateway');
  assert.equal(view._readingHeldDiff, true, 'the gate stays readable');
  assert.deepEqual(view._diffFiles, [
    { path: 'src/gate.ts', status: 'M', additions: 1, deletions: 1 },
    { path: 'src/added.ts', status: 'A', additions: 1, deletions: 0 },
  ]);
  assert.equal(view._selectedFile, 'src/gate.ts');
  assert.equal(view._fileDiff, changedSection);
  await view._selectFile('src/added.ts');
  assert.equal(view._fileDiff, `${addedSection}\n`);

  view._openDiffModal('Package diff', { path: 'artifacts/package.diff' });
  await flush();
  assert.equal(view._diffModalText, packageDiff);
  assert.equal(view._diffModalUrl, '');

  // Both sides of a touched file come from their blob ids in the held diff.
  const base = heldBlobId(packageDiff, 'src/gate.ts', 'base');
  const head = heldBlobId(packageDiff, 'src/gate.ts', 'head');
  assert.equal(await openHeldText({ kind: 'blob', id: base! }), baseFile);
  assert.equal(await openHeldText({ kind: 'blob', id: head! }), headFile);

  let shown: Blob | undefined;
  t.mock.method(URL, 'createObjectURL', (blob: Blob) => {
    shown = blob;
    return 'blob:held-image';
  });
  t.mock.method(URL, 'revokeObjectURL', () => undefined);
  const media = await loadGatewayMedia(
    view._artifactUrl(imageArtifact.path, imageArtifact),
    new AbortController().signal,
  );
  assert.equal(media.url, 'blob:held-image');
  assert.deepEqual(new Uint8Array(await shown!.arrayBuffer()), image);

  // Opening promotes prefetched content, so prefetch can no longer evict it.
  assert.deepEqual(await fixture.origins(), {
    [diffKey.id]: 'opened',
    [baseId]: 'opened',
    [headId]: 'opened',
    [imageSha]: 'opened',
  });
});

test('content opened live is verified and kept as opened', async (t) => {
  gateway.connectionState = 'connected';
  const fixture = openCache(t);
  setGatewayMemoryAuth({ token: 'service-fixture' }, 'ws://localhost:7777/ws');
  t.after(clearGatewayMemoryAuth);
  const fetched: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost:7777');
    fetched.push(url.searchParams.get('path') ?? url.pathname);
    return url.searchParams.get('path') === imageArtifact.path
      ? new Response(image, { headers: { 'content-type': 'image/png' } })
      : new Response(packageDiff);
  });
  t.mock.method(URL, 'createObjectURL', () => 'blob:live-image');
  t.mock.method(URL, 'revokeObjectURL', () => undefined);

  const view = makePresenter();
  view._openDiffModal('Package diff', { path: 'artifacts/package.diff' });
  await flush();
  assert.equal(view._diffModalText, packageDiff);
  const media = await loadGatewayMedia(
    view._artifactUrl(imageArtifact.path, imageArtifact),
    new AbortController().signal,
  );
  assert.equal(media.url, 'blob:live-image');
  await flush();
  assert.deepEqual(fetched, ['artifacts/package.diff', imageArtifact.path]);
  assert.deepEqual(await fixture.origins(), { [diffKey.id]: 'opened', [imageSha]: 'opened' });

  // Held now: a second open reads no bytes from the gateway.
  view._diffModalOpen = false;
  view._openDiffModal('Package diff', { path: 'artifacts/package.diff' });
  await flush();
  assert.equal(view._diffModalText, packageDiff);
  assert.equal(fetched.length, 2);
});

test('offline with nothing held keeps the waiting gate and adds no error', async (t) => {
  gateway.connectionState = 'connected';
  const fixture = openCache(t);
  fixture.goOffline();
  const view = makePresenter();
  await view._beginRecovery();
  await flush();
  assert.equal(view._recoveryPhase, 'stale');
  assert.equal(view._readingHeldDiff, false);
  assert.deepEqual(view._diffFiles, []);
  assert.equal(view._diffError, '');
});

test('a diff modal restored from the URL opens the package diff from held bytes after a reload', async (t) => {
  gateway.connectionState = 'connected';
  const fixture = openCache(t);
  assert.equal(
    await fixture.cache.storeContent({
      key: diffKey,
      data: encoder.encode(packageDiff),
      origin: 'prefetch',
      cohort: 'gate',
    }),
    true,
  );
  fixture.goOffline();
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Offline gates read held bytes'));
  const hash = location.hash;
  t.after(() => {
    location.hash = hash;
  });

  location.hash = '#run/gate-run?modal=diff&diffArtifact=artifacts%2Fpackage.diff';
  const view = makePresenter();
  view._readViewStateFromHash();
  assert.equal(view._diffModalOpen, true);
  assert.equal(view._diffModalArtifactPath, 'artifacts/package.diff');
  assert.equal(view._diffModalUrl, '', 'no URL load is started for the package diff');
  view.willUpdate();
  await flush();
  assert.equal(view._diffModalText, packageDiff);
  assert.equal(view._diffModalUrl, '');
  assert.equal((await fixture.origins())[diffKey.id], 'opened');

  // Any other diff artifact keeps loading from its URL once the gate is known.
  location.hash = '#run/gate-run?modal=diff&diffArtifact=artifacts%2Fother.diff';
  const other = makePresenter();
  other._readViewStateFromHash();
  other.willUpdate();
  await flush();
  assert.equal(other._diffModalText, '');
  assert.match(other._diffModalUrl, /path=artifacts%2Fother\.diff/);
});
