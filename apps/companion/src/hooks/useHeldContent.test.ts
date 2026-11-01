import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { URL } from 'node:url';

import { reviewDiffHash, reviewSnapshotIdentityText, type Run } from '@farmslot/protocol';
import * as clientCache from '@farmslot/protocol/client-cache';

import type { ArtifactHttpHeaders } from '../lib/artifact-url';
import * as artifactUrl from '../lib/artifact-url';
import type { GateDiffContent, GateDiffSource } from '../lib/held-content';
import * as heldContent from '../lib/held-content';

import { mountHook } from './hook-harness.fixtures';
import type { ArtifactImageRead } from './useHeldContent';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
const IMAGE = { path: 'evidence/a.png', sha256: createHash('sha256').update(PNG).digest('hex') };
const IMAGE_URI = 'https://gateway.invalid/api/run-artifact?path=evidence/a.png';
const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
const DIFF_SOURCE: GateDiffSource = {
  key: { kind: 'diff', id: reviewDiffHash(reviewSnapshotIdentityText(DIFF, [])) },
  runId: 'run-1',
  path: 'review/diff.patch',
  untrackedFiles: [],
};
const RUN = { id: 'run-1' } as Run;

interface Read {
  headers: Record<string, string>;
  signal: AbortSignal;
  respond(status: number, body?: Uint8Array<ArrayBuffer>): void;
}

/** Every fetch a hook starts, answered by the test; an abort rejects it, as `fetch` does. */
function fakeFetch(t: TestContext): Read[] {
  const reads: Read[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    (_uri: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
        reads.push({
          headers: init.headers as Record<string, string>,
          signal: init.signal as AbortSignal,
          respond: (status, body) => resolve(new Response(body ?? null, { status })),
        });
      }),
  );
  return reads;
}

/** One hook over a live connection whose headers and transport the test sets between renders. */
function mount(exportName: string) {
  const live = {
    connected: true,
    headers: { Authorization: 'Bearer a' } as ArtifactHttpHeaders,
  };
  const hook = mountHook<unknown[]>(
    new URL('./useHeldContent.ts', import.meta.url),
    exportName,
    {
      '@farmslot/protocol/client-cache': clientCache,
      '../lib/artifact-url': artifactUrl,
      '../lib/content-prefetch': { companionRunDiffBase: () => undefined },
      '../lib/held-content': {
        ...heldContent,
        gateDiffSource: (run: Run | null) => (run ? DIFF_SOURCE : undefined),
      },
      '../lib/resource-cache': {
        getResourceCache: () => undefined,
        subscribeResourceCache: () => () => undefined,
      },
      '../lib/use-workspace-render-access': { useWorkspaceRenderAccess: () => 'farm' },
      '../store/connection': {
        useConnectionStore: (select: (state: object) => unknown) =>
          select({
            gatewayUrl: 'https://gateway.invalid',
            activeProfileHttpAuthHeaders: live.headers,
          }),
      },
      './useConfigurationProjects': { useConfigurationProjects: () => [] },
      './useConnectedTransport': { useConnectedTransport: () => (live.connected ? {} : null) },
    },
    { AbortController },
  );
  return { live, hook };
}

const hooks = {
  'an evidence image': {
    open() {
      const { live, hook } = mount('useArtifactImageSource');
      const state = () =>
        (hook.render(IMAGE_URI, live.headers, IMAGE) as { read: ArtifactImageRead }).read;
      return { live, state };
    },
    body: PNG,
  },
  'the gate diff': {
    open() {
      const { live, hook } = mount('useGateDiffContent');
      const state = () => (hook.render(RUN) as GateDiffContent).status;
      return { live, state };
    },
    body: new TextEncoder().encode(DIFF),
  },
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

for (const [name, { open, body }] of Object.entries(hooks)) {
  test(`${name}: equal headers set again mid-read keep that read, and its 503 commits`, async (t) => {
    const reads = fakeFetch(t);
    const { live, state } = open();
    state();
    await flush();
    assert.equal(reads.length, 1);
    // A connection callback stores a new headers object with the same contents.
    live.headers = { ...live.headers };
    state();
    await flush();
    assert.equal(reads.length, 1, 'no second read');
    assert.equal(reads[0]?.signal.aborted, false, 'the read in flight goes on');
    reads[0]?.respond(503);
    await flush();
    assert.equal(state(), 'unavailable');
  });

  test(`${name}: changed header values restart the read with them`, async (t) => {
    const reads = fakeFetch(t);
    const { live, state } = open();
    state();
    await flush();
    live.headers = { Authorization: 'Bearer b' };
    state();
    await flush();
    assert.equal(reads[0]?.signal.aborted, true, 'the read under the old credential stops');
    assert.equal(reads.length, 2);
    assert.equal(reads[1]?.headers.Authorization, 'Bearer b');
    reads[1]?.respond(200, body);
    await flush();
    assert.equal(state(), 'ready');
  });

  test(`${name}: reconnecting retries an unavailable read`, async (t) => {
    const reads = fakeFetch(t);
    const { live, state } = open();
    live.connected = false;
    state();
    await flush();
    assert.equal(state(), 'unavailable', 'offline with nothing held');
    assert.equal(reads.length, 0);
    live.connected = true;
    state();
    await flush();
    assert.equal(reads.length, 1, 'the reconnect reads again');
    reads[0]?.respond(200, body);
    await flush();
    assert.equal(state(), 'ready');
  });
}

test('an image held as a verified file shows from the device with no read, offline too', async (t) => {
  const reads = fakeFetch(t);
  const file = 'file:///cache/evidence-media/scope/a.png';
  artifactUrl.setHeldArtifactLookup({
    byPath: () => undefined,
    byDigest: (sha256) => (sha256 === IMAGE.sha256 ? file : undefined),
  });
  try {
    const { live, hook } = mount('useArtifactImageSource');
    live.connected = false;
    const render = () =>
      hook.render(IMAGE_URI, live.headers, IMAGE) as { source: unknown; read: ArtifactImageRead };
    render();
    await flush();
    const shown = render() as { source: { uri?: string }; read: ArtifactImageRead };
    assert.equal(shown.source.uri, file);
    assert.equal(shown.read, 'ready');
    assert.equal(reads.length, 0);
  } finally {
    artifactUrl.setHeldArtifactLookup(undefined);
  }
});

test('a ready image keeps its source object when equal headers are set again', async (t) => {
  const reads = fakeFetch(t);
  const { live, hook } = mount('useArtifactImageSource');
  const render = () =>
    hook.render(IMAGE_URI, live.headers, IMAGE) as { source: unknown; read: ArtifactImageRead };
  render();
  await flush();
  reads[0]?.respond(200, PNG);
  await flush();
  const ready = render();
  assert.equal(ready.read, 'ready');
  live.headers = { ...live.headers };
  // A new source re-encodes the bytes and resets ArtifactImage's loaded state.
  assert.equal(render().source, ready.source, 'the same data URI source');
});

test('an image unmounted mid-fetch reports nothing after its cleanup, not even the abort', async (t) => {
  const reads = fakeFetch(t);
  const { live, hook } = mount('useArtifactImageSource');
  const events: string[] = [];
  hook.render(IMAGE_URI, live.headers, IMAGE, (run: number, stage: string, fetch?: object) =>
    events.push(`${run} ${stage}${fetch ? ` ${JSON.stringify(fetch)}` : ''}`),
  );
  await flush();
  assert.equal(reads.length, 1);
  hook.cleanup();
  // The aborted fetch rejects after the cleanup.
  await flush();
  assert.equal(reads[0]?.signal.aborted, true);
  assert.deepEqual(events, ['1 open-held', '1 fetch', '1 aborted']);
});
