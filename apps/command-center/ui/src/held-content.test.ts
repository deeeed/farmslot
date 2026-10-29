import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { reviewDiffHash, type RunDecisionPayload } from '@farmslot/protocol';
import {
  createGatewayResourceCache,
  createMemoryResourceStore,
  type GatewayResourceCache,
} from '@farmslot/protocol/client-cache';

let cache: GatewayResourceCache | undefined;
mock.module('./resource-cache.js', { namedExports: { getResourceCache: () => cache } });
const {
  CONTENT_MISMATCH,
  decisionDiffArtifact,
  frozenDiffAlias,
  heldBlobId,
  heldDiffFiles,
  heldFileDiff,
  openHeldText,
  readVerifiedText,
} = await import('./held-content.js');

const oldId = 'a'.repeat(40);
const newId = 'b'.repeat(40);
const diff = `diff --git a/src/kept.ts b/src/kept.ts
index ${oldId}..${newId} 100644
--- a/src/kept.ts
+++ b/src/kept.ts
@@ -1,2 +1,2 @@
-one
+two
 three
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 90%
rename from src/old-name.ts
rename to src/new-name.ts
index 1111111..2222222 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1 +1,2 @@
 kept
+added
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index ${oldId}..${'0'.repeat(40)}
--- a/src/gone.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

test('a held diff lists its files and splits each file section', () => {
  assert.deepEqual(heldDiffFiles(diff), [
    { path: 'src/kept.ts', status: 'M', additions: 1, deletions: 1 },
    {
      path: 'src/new-name.ts',
      status: 'R',
      oldPath: 'src/old-name.ts',
      additions: 1,
      deletions: 0,
    },
    { path: 'src/gone.ts', status: 'D', additions: 0, deletions: 1 },
  ]);
  assert.match(heldFileDiff(diff, 'src/new-name.ts') ?? '', /^diff --git a\/src\/old-name.ts/);
  assert.equal(heldFileDiff(diff, 'src/missing.ts'), undefined);
});

test('a review diff read is pinned to the bundle its payload records; older payloads read the current one', () => {
  const bundle = { bundleDigest: 'review-bundle', manifestDigest: 'manifest' };
  const review = (artifactBundle?: typeof bundle) =>
    ({ kind: 'review', ...(artifactBundle ? { artifactBundle } : {}) }) as RunDecisionPayload;
  assert.deepEqual(decisionDiffArtifact('run-a', 'review/input.diff', review(bundle)), {
    runId: 'run-a',
    path: 'review/input.diff',
    bundleDigest: 'review-bundle',
  });
  assert.deepEqual(decisionDiffArtifact('run-a', 'review/input.diff', review()), {
    runId: 'run-a',
    path: 'review/input.diff',
  });
  assert.deepEqual(decisionDiffArtifact('run-a', 'review/input.diff', undefined), {
    runId: 'run-a',
    path: 'review/input.diff',
  });
});

test('blob ids name both sides; an abbreviated id cannot be looked up', () => {
  assert.equal(heldBlobId(diff, 'src/kept.ts', 'base'), oldId);
  assert.equal(heldBlobId(diff, 'src/kept.ts', 'head'), newId);
  assert.equal(heldBlobId(diff, 'src/new-name.ts', 'head'), undefined);
  assert.equal(heldBlobId(diff, 'src/gone.ts', 'head'), undefined);
});

test('a frozen review diff opens by its alias and is then held as opened', async (t) => {
  const store = createMemoryResourceStore();
  cache = createGatewayResourceCache({
    store,
    transport: {
      getConnection: () => ({
        id: 1,
        connected: true,
        authMode: 'none',
        scope: { gatewayUrl: 'ws://held.test' },
      }),
      onConnectionChange: () => () => {},
      onResourceChanged: () => () => {},
      resynchronize() {},
      request: () => new Promise(() => {}),
    },
  });
  t.after(async () => {
    await cache?.dispose();
    cache = undefined;
  });
  const alias = frozenDiffAlias('review-run', 'base-sha', 'head-sha');
  assert.equal(alias, 'frozen-diff:review-run:base-sha:head-sha');
  const stored = await cache.storeContent({
    key: { kind: 'diff', id: reviewDiffHash(diff) },
    data: new TextEncoder().encode(diff),
    origin: 'prefetch',
    cohort: 'run',
    alias,
  });
  assert.equal(stored, true);
  assert.equal(await openHeldText(alias), diff);
  assert.deepEqual(
    (await store.listContent()).map(({ kind, origin }) => [kind, origin]),
    [['diff', 'opened']],
  );
  assert.equal(await openHeldText(frozenDiffAlias('review-run', 'base-sha', 'other')), undefined);
});

test('a live diff read is shown and kept only when it matches its diffHash', async (t) => {
  const store = createMemoryResourceStore();
  cache = createGatewayResourceCache({
    store,
    transport: {
      getConnection: () => ({
        id: 1,
        connected: true,
        authMode: 'none',
        scope: { gatewayUrl: 'ws://held.test' },
      }),
      onConnectionChange: () => () => {},
      onResourceChanged: () => () => {},
      resynchronize() {},
      request: () => new Promise(() => {}),
    },
  });
  t.after(async () => {
    await cache?.dispose();
    cache = undefined;
  });
  const key = { kind: 'diff' as const, id: reviewDiffHash(diff) };
  const bytes = (text: string) => async () => new TextEncoder().encode(text);
  // The review snapshot's path now holds a later retain's diff.
  const other = diff.replace('+two', '+changed');
  assert.equal(await readVerifiedText(key, bytes(other), 'gate'), CONTENT_MISMATCH);
  assert.deepEqual(await store.listContent(), []);
  const failed = async () => {
    throw new Error('offline');
  };
  assert.equal(await readVerifiedText(key, failed, 'gate'), undefined);
  assert.equal(await readVerifiedText(key, bytes(diff), 'gate'), diff);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    (await store.listContent()).map(({ kind, origin }) => [kind, origin]),
    [['diff', 'opened']],
  );
});
