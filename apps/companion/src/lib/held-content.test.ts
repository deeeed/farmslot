import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { reviewDiffHash, reviewSnapshotIdentityText } from '@farmslot/protocol';
import {
  type ContentKey,
  createGatewayResourceCache,
  createMemoryResourceStore,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
} from '@farmslot/protocol/client-cache';

import {
  artifactImageKey,
  fetchRunArtifactBytes,
  gateDiffContent,
  gateDiffFallsBack,
  type HeldContentResult,
  heldImageSource,
  imageDataUri,
  openHeldContent,
} from './held-content';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
const DIFF = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n';
const diffKey: ContentKey = {
  kind: 'diff',
  id: reviewDiffHash(reviewSnapshotIdentityText(DIFF, [])),
};
const imageKey: ContentKey = {
  kind: 'artifact',
  id: createHash('sha256').update(PNG).digest('hex'),
};
const PNG_URI = `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`;
const text = (result: HeldContentResult) =>
  result.status === 'ready' ? new TextDecoder().decode(result.data) : result.status;

function harness() {
  const connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://held.invalid/', principalId: 'owner', principalGeneration: 0 },
    authority: { roles: [], workspaceAccess: 'farm' },
  };
  const transport: ResourceCacheTransport = {
    getConnection: () => connection,
    onConnectionChange: () => () => {},
    onResourceChanged: () => () => {},
    request: () => Promise.reject(new Error('no query reads')),
    resynchronize: () => {},
  };
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  const origin = async (key: ContentKey) =>
    (await store.listContent()).find((row) => row.kind === key.kind && row.id === key.id)?.origin;
  return { cache, store, origin };
}

test('content fetched live on open is verified, shown and stored as opened, then opens held', async () => {
  const { cache, origin } = harness();
  let reads = 0;
  const read = async () => {
    reads++;
    return new TextEncoder().encode(DIFF);
  };
  try {
    const opened = await openHeldContent({ cache, key: diffKey, cohort: 'gate', read });
    assert.equal(text(opened), DIFF);
    assert.equal(await origin(diffKey), 'opened');
    const again = await openHeldContent({ cache, key: diffKey, cohort: 'gate', read });
    assert.equal(text(again), DIFF);
    assert.equal(reads, 1, 'held content is not transferred again');
  } finally {
    await cache.dispose();
  }
});

test('prefetched content becomes opened when the user opens it', async () => {
  const { cache, origin } = harness();
  try {
    assert.equal(
      await cache.storeContent({ key: imageKey, data: PNG, origin: 'prefetch', cohort: 'gate' }),
      true,
    );
    assert.equal(await origin(imageKey), 'prefetch');
    const image = await openHeldContent({ cache, key: imageKey, cohort: 'gate' });
    assert.ok(image.status === 'ready');
    assert.equal(imageDataUri(image.data), PNG_URI);
    assert.equal(await origin(imageKey), 'opened');
  } finally {
    await cache.dispose();
  }
});

test('mismatched live bytes are a mismatch, never stored, and distinct from a failed or absent read', async () => {
  const { cache, store } = harness();
  try {
    const wrong = await openHeldContent({
      cache,
      key: diffKey,
      cohort: 'gate',
      read: async () => new TextEncoder().encode(`${DIFF}+tampered\n`),
    });
    assert.deepEqual(wrong, { status: 'mismatch' });
    const wrongImage = await openHeldContent({
      cache,
      key: imageKey,
      cohort: 'gate',
      read: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]),
    });
    assert.deepEqual(wrongImage, { status: 'mismatch' });
    const failed = await openHeldContent({
      cache,
      key: imageKey,
      cohort: 'gate',
      read: () => Promise.reject(new Error('offline')),
    });
    assert.deepEqual(failed, { status: 'unavailable' });
    assert.deepEqual(await openHeldContent({ cache, key: imageKey, cohort: 'gate' }), {
      status: 'unavailable',
    });
    assert.deepEqual(await store.listContent(), []);
  } finally {
    await cache.dispose();
  }
});

test('an image whose live bytes mismatched never reloads its URL; only a failed or absent read does', () => {
  const url = { uri: 'https://gateway.invalid/api/run-artifact?path=a.png' };
  assert.deepEqual(heldImageSource({ status: 'ready', data: PNG }, url), { uri: PNG_URI });
  assert.equal(heldImageSource({ status: 'unavailable' }, url), url);
  assert.equal(heldImageSource({ status: 'mismatch' }, url), undefined);
  // A verified image over 2 MB still loads from its URL, as today.
  assert.equal(
    heldImageSource({ status: 'ready', data: new Uint8Array(3 * 1024 * 1024) }, url),
    url,
  );
});

test('a package diff that mismatched never falls back to the artifact URL renderer', () => {
  const ready = gateDiffContent({ status: 'ready', data: new TextEncoder().encode(DIFF) });
  assert.deepEqual(ready, { status: 'ready', text: DIFF });
  assert.equal(gateDiffFallsBack(ready), false);
  assert.equal(gateDiffFallsBack(gateDiffContent({ status: 'mismatch' })), false);
  assert.equal(gateDiffFallsBack({ status: 'loading' }), false);
  assert.equal(gateDiffFallsBack(gateDiffContent({ status: 'unavailable' })), true);
  assert.equal(gateDiffFallsBack({ status: 'none' }), true);
});

test('evidence images are content by manifest sha256 up to 2 MB', () => {
  const sha256 = imageKey.id;
  assert.deepEqual(artifactImageKey({ path: 'evidence/a.png', sha256 }), imageKey);
  assert.equal(artifactImageKey({ path: 'evidence/a.png' }), undefined);
  assert.equal(artifactImageKey({ path: 'evidence/run.mp4', sha256 }), undefined);
  assert.equal(
    artifactImageKey({ path: 'evidence/a.png', sha256, sizeBytes: 3 * 1024 * 1024 }),
    undefined,
  );
  assert.equal(imageDataUri(new Uint8Array(2 * 1024 * 1024 + 1)), undefined);
});

test('artifact reads carry the bundle digest and auth headers, and refusals are authorization errors', async (t) => {
  const original = globalThis.fetch;
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  let status = 403;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: init?.headers as Record<string, string> });
    return status === 200 ? new Response(PNG) : new Response(null, { status });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const read = () =>
    fetchRunArtifactBytes(
      'wss://gateway.invalid/ws',
      { Authorization: 'Bearer token' },
      { runId: 'run-a', path: 'evidence/a.png', bundleDigest: 'digest-a' },
    );
  await assert.rejects(read(), { code: 'AUTH_FORBIDDEN' });
  status = 401;
  await assert.rejects(read(), { code: 'AUTH_FORBIDDEN' });
  status = 500;
  await assert.rejects(read(), (error: Error & { code?: string }) => error.code === undefined);
  status = 200;
  assert.deepEqual(await read(), PNG);
  assert.equal(
    seen[0]!.url,
    'https://gateway.invalid/api/run-artifact?runId=run-a&path=evidence%2Fa.png&bundleDigest=digest-a',
  );
  assert.equal(seen[0]!.headers.Authorization, 'Bearer token');
});
