import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

import { ResourceCacheConformanceTransport } from '../../src/client-cache/conformance.js';
import {
  type ContentKey,
  createGatewayResourceCache,
  createMemoryResourceStore,
  gitBlobHash,
  RESOURCE_CONTENT_LIMITS,
  type ResourceContentCohort,
  type ResourceContentOrigin,
  type ResourceContentRetain,
  resourceContentWithinLimits,
  resourceQuery,
  type ResourceStore,
  verifyResourceContent,
} from '../../src/client-cache/index.js';
import { reviewDiffHash, reviewSnapshotIdentityText } from '../../src/runs/review-diff-identity.js';

const scope = { gatewayUrl: 'ws://content.invalid/', principalId: 'owner', principalGeneration: 0 };
const encoder = new TextEncoder();
const mb = 1024 * 1024;

function blob(text: string) {
  const data = encoder.encode(text);
  return { key: { kind: 'blob' as const, id: gitBlobHash(data) }, data };
}
function artifact(data: Uint8Array) {
  return { key: { kind: 'artifact' as const, id: bytesToHex(sha256(data)) }, data };
}
function png(bytes: number): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return data;
}

function fixture(contentBudgetBytes?: number, store: ResourceStore = createMemoryResourceStore()) {
  const transport = new ResourceCacheConformanceTransport(scope);
  transport.setConnection({
    connected: true,
    id: 1,
    capabilities: {
      ...transport.connection.capabilities!,
      resourceChanges: {
        version: 1,
        epoch: 'conformance-epoch',
        versionLists: false,
        observedReads: 1,
        workspaceReads: 1,
      },
    },
  });
  const cache = createGatewayResourceCache({ transport, store, contentBudgetBytes });
  const labels = new Map<string, string>();
  const content = new Map<string, { key: ContentKey; data: Uint8Array }>();
  return {
    transport,
    store,
    cache,
    /** Stores a text blob of an exact size under a readable label. */
    put(
      label: string,
      bytes: number,
      origin: ResourceContentOrigin,
      cohort: ResourceContentCohort,
      alias?: string,
    ) {
      const entry = content.get(label) ?? blob(label.padEnd(bytes, '.'));
      content.set(label, entry);
      labels.set(entry.key.id, label);
      return cache.storeContent({ ...entry, origin, cohort, alias });
    },
    open: (label: string) => cache.openContent(content.get(label)!.key),
    retain: (label: string, retain: ResourceContentRetain) =>
      cache.retainContent(content.get(label)!.key, retain),
    /** The label an alias resolves to. */
    async byAlias(alias: string) {
      const data = await cache.readContentByAlias(alias);
      return data && labels.get(gitBlobHash(data));
    },
    async held() {
      return (await store.listContent())
        .map((row) => `${labels.get(row.id)}:${row.origin}:${row.cohort}`)
        .sort();
    },
  };
}

function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  return () => t.mock.timers.tick(1);
}

test('identities verify a diff with its untracked manifest, a git blob and an artifact sha256', () => {
  const diff = encoder.encode(
    'diff --git a/x b/x\nindex 1234567..89abcde 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
  );
  const untrackedFiles = [
    { path: 'new.txt', blobSha: blob('new\n').key.id, mode: '100644' as const },
  ];
  const diffHash = reviewDiffHash(
    reviewSnapshotIdentityText(new TextDecoder().decode(diff), untrackedFiles),
  );
  assert.ok(verifyResourceContent({ kind: 'diff', id: diffHash }, diff, untrackedFiles));
  assert.ok(!verifyResourceContent({ kind: 'diff', id: diffHash }, diff));
  assert.equal(blob('hello\n').key.id, 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(gitBlobHash(new Uint8Array()), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.ok(verifyResourceContent(blob('hello\n').key, encoder.encode('hello\n')));
  assert.ok(!verifyResourceContent(blob('hello\n').key, encoder.encode('hello')));
  const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  assert.ok(verifyResourceContent({ kind: 'artifact', id: abc }, encoder.encode('abc')));
  assert.ok(!verifyResourceContent({ kind: 'artifact', id: abc }, encoder.encode('abd')));
  assert.ok(!verifyResourceContent({ kind: 'blob', id: abc }, encoder.encode('abc')));
});

test('a legacy raw SHA-256 package diffHash verifies and keeps its recorded id', async () => {
  const { cache, store } = fixture();
  // The index line makes the canonical hash differ from the legacy raw hash.
  const text =
    'diff --git a/x b/x\nindex 1234567..89abcde 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
  const untrackedFiles = [
    { path: 'new.txt', blobSha: blob('new\n').key.id, mode: '100644' as const },
  ];
  const identity = reviewSnapshotIdentityText(text, untrackedFiles);
  const key = { kind: 'diff' as const, id: bytesToHex(sha256(encoder.encode(identity))) };
  const data = encoder.encode(text);
  try {
    assert.notEqual(key.id, reviewDiffHash(identity));
    assert.ok(
      await cache.storeContent({ key, data, untrackedFiles, origin: 'prefetch', cohort: 'gate' }),
    );
    assert.deepEqual(await cache.readContent(key), data);
    assert.deepEqual(
      (await store.listContent()).map((row) => row.id),
      [key.id],
    );
    const withoutManifest = { kind: 'diff' as const, id: bytesToHex(sha256(data)) };
    assert.equal(
      await cache.storeContent({
        key: withoutManifest,
        data,
        untrackedFiles,
        origin: 'prefetch',
        cohort: 'gate',
      }),
      false,
    );
  } finally {
    await cache.dispose();
  }
});

test('mismatched bytes are refused and nothing is stored', async () => {
  const { cache, store } = fixture();
  try {
    const data = encoder.encode('served bytes\n');
    for (const key of [
      { kind: 'diff' as const, id: reviewDiffHash('other diff') },
      { kind: 'blob' as const, id: gitBlobHash(encoder.encode('expected bytes\n')) },
      { kind: 'artifact' as const, id: bytesToHex(sha256(encoder.encode('expected'))) },
    ]) {
      assert.equal(
        await cache.storeContent({ key, data, origin: 'opened', cohort: 'gate' }),
        false,
      );
      assert.equal(await cache.readContent(key), undefined);
    }
    assert.deepEqual(await store.listContent(), []);
    assert.equal((await store.byteTotals()).content, 0);
  } finally {
    await cache.dispose();
  }
});

test('large or binary files and large diffs are refused; evidence images up to 2 MB are kept', async () => {
  const { cache, store } = fixture();
  const limits = RESOURCE_CONTENT_LIMITS;
  try {
    const store1 = (entry: { key: ContentKey; data: Uint8Array }) =>
      cache.storeContent({ ...entry, origin: 'prefetch', cohort: 'gate' });
    assert.equal(await store1(blob('f'.repeat(limits.fileBytes))), true);
    assert.equal(await store1(blob('f'.repeat(limits.fileBytes + 1))), false);
    assert.equal(await store1(blob('binary\0file')), false);
    const diffText = `diff --git a/x b/x\n${'+'.repeat(limits.diffBytes)}\n`;
    const diff = encoder.encode(diffText);
    assert.equal(
      await store1({ key: { kind: 'diff', id: reviewDiffHash(diffText) }, data: diff }),
      false,
    );
    const smallDiff = 'diff --git a/x b/x\n+ok\n';
    assert.equal(
      await store1({
        key: { kind: 'diff', id: reviewDiffHash(smallDiff) },
        data: encoder.encode(smallDiff),
      }),
      true,
    );
    assert.equal(await store1(artifact(png(2 * mb))), true);
    assert.equal(await store1(artifact(png(2 * mb + 1))), false);
    const jpeg = new Uint8Array(mb + 10);
    jpeg.set([0xff, 0xd8, 0xff]);
    assert.equal(await store1(artifact(jpeg)), true);
    assert.equal(await store1(artifact(new Uint8Array(mb + 1).fill(1))), false);
    assert.equal(await store1(artifact(new Uint8Array(mb).fill(1))), true);
    assert.equal((await store.listContent()).length, 5);
    assert.ok(resourceContentWithinLimits({ kind: 'blob', id: '' }, new Uint8Array()));
  } finally {
    await cache.dispose();
  }
});

test('the least recently used entry goes first, and opening refreshes recency', async (t) => {
  const tick = clock(t);
  const { cache, put, open, held } = fixture(100);
  try {
    for (const label of ['a', 'b', 'c']) {
      tick();
      assert.ok(await put(label, 30, 'opened', 'gate'));
    }
    tick();
    assert.ok(await open('a'));
    tick();
    assert.ok(await put('d', 30, 'opened', 'run'));
    assert.deepEqual(await held(), ['a:opened:gate', 'c:opened:gate', 'd:opened:run']);
  } finally {
    await cache.dispose();
  }
});

test('prefetch takes at most half the budget, replacing older prefetch first', async (t) => {
  const tick = clock(t);
  const { cache, put, held } = fixture(100);
  try {
    for (const label of ['p1', 'p2', 'p3']) {
      tick();
      assert.ok(await put(label, 20, 'prefetch', 'gate'));
    }
    assert.deepEqual(await held(), ['p2:prefetch:gate', 'p3:prefetch:gate']);
    tick();
    assert.equal(await put('too-large', 51, 'prefetch', 'gate'), false);
    assert.deepEqual(await held(), ['p2:prefetch:gate', 'p3:prefetch:gate']);
  } finally {
    await cache.dispose();
  }
});

test('prefetch never evicts content the user opened, including content opened after prefetch', async (t) => {
  const tick = clock(t);
  const { cache, put, open, held } = fixture(100);
  try {
    tick();
    assert.ok(await put('opened', 60, 'opened', 'run'));
    tick();
    assert.equal(await put('blocked', 45, 'prefetch', 'gate'), false);
    tick();
    assert.ok(await put('later-opened', 40, 'prefetch', 'gate'));
    tick();
    assert.ok(await open('later-opened'));
    tick();
    assert.equal(await put('blocked-again', 10, 'prefetch', 'gate'), false);
    assert.deepEqual(await held(), ['later-opened:opened:gate', 'opened:opened:run']);
  } finally {
    await cache.dispose();
  }
});

test('active-run prefetch is refused rather than evict gate content; gate prefetch may evict both', async (t) => {
  const tick = clock(t);
  const { cache, put, held } = fixture(100);
  try {
    tick();
    assert.ok(await put('gate', 30, 'prefetch', 'gate'));
    tick();
    assert.ok(await put('run1', 20, 'prefetch', 'run'));
    tick();
    assert.ok(await put('run2', 20, 'prefetch', 'run'));
    assert.deepEqual(await held(), ['gate:prefetch:gate', 'run2:prefetch:run']);
    tick();
    assert.equal(await put('run3', 40, 'prefetch', 'run'), false);
    assert.deepEqual(await held(), ['gate:prefetch:gate', 'run2:prefetch:run']);
    tick();
    assert.ok(await put('gate2', 40, 'prefetch', 'gate'));
    assert.deepEqual(await held(), ['gate2:prefetch:gate']);
  } finally {
    await cache.dispose();
  }
});

test('storing held content refreshes recency and keeps the stronger origin and cohort', async (t) => {
  const tick = clock(t);
  const { cache, store, put, held } = fixture(100);
  try {
    tick();
    assert.ok(await put('shared', 10, 'prefetch', 'run'));
    tick();
    assert.ok(await put('shared', 10, 'prefetch', 'gate'));
    assert.deepEqual(await held(), ['shared:prefetch:gate']);
    tick();
    assert.ok(await put('shared', 10, 'opened', 'run'));
    tick();
    assert.ok(await put('shared', 10, 'prefetch', 'run'));
    assert.deepEqual(await held(), ['shared:opened:gate']);
    assert.equal((await store.listContent())[0].accessedAt, 4);
    assert.equal((await store.byteTotals()).content, 10);
  } finally {
    await cache.dispose();
  }
});

test('workspace snapshots and content share one least recently used budget', async (t) => {
  const tick = clock(t);
  const { cache, store, transport, put, held } = fixture(100);
  const snapshot = (path: string) =>
    resourceQuery<{ value: string }>('fs.read', { slotId: 'slot', runId: 'run', path });
  const save = async (path: string) => {
    const reading = cache.retry(snapshot(path));
    // 40 serialized bytes.
    (await transport.nextRead()).resolve({ value: 'x'.repeat(28) });
    await reading;
  };
  const snapshots = async () => (await store.listQueries()).map((row) => row.id);
  try {
    tick();
    await save('first');
    assert.deepEqual(await snapshots(), [snapshot('first').id]);
    tick();
    assert.ok(await put('opened', 50, 'opened', 'gate'));
    tick();
    assert.equal(await put('prefetch', 20, 'prefetch', 'gate'), false);
    assert.deepEqual(await snapshots(), [snapshot('first').id]);
    tick();
    assert.ok(await put('opened2', 30, 'opened', 'gate'));
    assert.deepEqual(await snapshots(), []);
    tick();
    await save('second');
    assert.deepEqual(await snapshots(), [snapshot('second').id]);
    assert.deepEqual(await held(), ['opened2:opened:gate']);
  } finally {
    await cache.dispose();
  }
});

test('content reads work offline, but writes need the current connection', async () => {
  const { cache, transport } = fixture();
  const entry = blob('offline\n');
  try {
    assert.ok(await cache.storeContent({ ...entry, origin: 'opened', cohort: 'gate' }));
    transport.setConnection({ connected: false }, 'network');
    assert.deepEqual(await cache.readContent(entry.key), entry.data);
    assert.deepEqual(await cache.openContent(entry.key), entry.data);
    assert.equal(
      await cache.storeContent({ ...blob('late\n'), origin: 'opened', cohort: 'gate' }),
      false,
    );
  } finally {
    await cache.dispose();
  }
});

test('deleteAll and disposal fence content writes and reads already in progress', async () => {
  const { cache, store } = fixture();
  const entry = blob('written before deletion\n');
  assert.ok(await cache.storeContent({ ...entry, origin: 'opened', cohort: 'gate' }));
  const writing = cache.storeContent({ ...blob('late\n'), origin: 'opened', cohort: 'gate' });
  const reading = cache.readContent(entry.key);
  await store.deleteAll();
  assert.equal(await writing, false);
  assert.equal(await reading, undefined);
  assert.deepEqual(await store.listContent(), []);
  await cache.dispose();
  assert.equal(await cache.readContent(entry.key), undefined);
  assert.equal(await cache.storeContent({ ...entry, origin: 'opened', cohort: 'gate' }), false);
});

test('a principal change during a held content read returns nothing to the old owner', async () => {
  const backing = createMemoryResourceStore();
  let started!: () => void;
  let release!: () => void;
  const entering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store: ResourceStore = {
    ...backing,
    get deleted() {
      return backing.deleted;
    },
    async getContent(key) {
      started();
      await held;
      return backing.getContent(key);
    },
  };
  const { cache, transport } = fixture(undefined, store);
  const entry = blob('private\n');
  try {
    assert.ok(await cache.storeContent({ ...entry, origin: 'opened', cohort: 'gate' }));
    const reading = cache.openContent(entry.key);
    await entering;
    transport.setConnection(
      { id: 2, connected: false, scope: { ...scope, principalId: 'replacement' } },
      'principal-change',
    );
    release();
    assert.equal(await reading, undefined);
    assert.equal(await cache.readContent(entry.key), undefined);
    assert.ok(backing.deleted);
  } finally {
    release();
    await cache.dispose();
  }
});

test('a write token from before a principal change refuses the late write', async () => {
  const { cache, transport } = fixture();
  const entry = blob('fetched by the previous owner\n');
  const write = (token = cache.contentWriteToken()) =>
    cache.storeContent({ ...entry, origin: 'prefetch', cohort: 'gate', token });
  try {
    const token = cache.contentWriteToken();
    transport.setConnection(
      { id: 2, connected: true, scope: { ...scope, principalId: 'replacement' } },
      'principal-change',
    );
    assert.equal(await write(token), false);
    assert.equal(await cache.readContent(entry.key), undefined);
    assert.ok(await write());
  } finally {
    await cache.dispose();
  }
});

test('a write token refuses bytes read on an earlier connection or store incarnation', async () => {
  const backing = createMemoryResourceStore();
  let failReads = false;
  const store: ResourceStore = {
    ...backing,
    get deleted() {
      return backing.deleted;
    },
    async getContent(key) {
      if (failReads) throw new Error('disk failed');
      return backing.getContent(key);
    },
  };
  const { cache, transport } = fixture(undefined, store);
  const entry = blob('token\n');
  const write = (token = cache.contentWriteToken()) =>
    cache.storeContent({ ...entry, origin: 'prefetch', cohort: 'gate', token });
  try {
    const before = cache.contentWriteToken();
    transport.setConnection({ connected: false }, 'network');
    transport.setConnection({ connected: true, id: 2 });
    assert.equal(await write(before), false);
    const reconnected = cache.contentWriteToken();
    failReads = true;
    // The failed read replaces the store with a memory incarnation.
    assert.equal(await cache.readContent(entry.key), undefined);
    assert.equal(await write(reconnected), false);
    assert.ok(await write());
  } finally {
    await cache.dispose();
  }
});

test('presence checks load no bytes, keep recency and follow the owner', async (t) => {
  const tick = clock(t);
  const backing = createMemoryResourceStore();
  let loads = 0;
  const store: ResourceStore = {
    ...backing,
    get deleted() {
      return backing.deleted;
    },
    async getContent(key) {
      loads++;
      return backing.getContent(key);
    },
  };
  const { cache, transport } = fixture(undefined, store);
  const entry = blob('present\n');
  try {
    tick();
    assert.ok(await cache.storeContent({ ...entry, origin: 'prefetch', cohort: 'run' }));
    tick();
    assert.equal(await cache.hasContent(entry.key), true);
    assert.equal(await cache.hasContent({ kind: 'diff', id: entry.key.id }), false);
    assert.equal(loads, 0);
    assert.deepEqual(
      (await backing.listContent()).map(({ origin, accessedAt }) => ({ origin, accessedAt })),
      [{ origin: 'prefetch', accessedAt: 1 }],
    );
    transport.setConnection(
      { id: 2, connected: false, scope: { ...scope, principalId: 'replacement' } },
      'principal-change',
    );
    assert.equal(await cache.hasContent(entry.key), false);
  } finally {
    await cache.dispose();
  }
});

test('a frozen review diff is found offline by its alias and opening it marks it opened', async () => {
  const { cache, store, transport } = fixture();
  const text = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n';
  const key = { kind: 'diff' as const, id: reviewDiffHash(text) };
  const data = encoder.encode(text);
  const alias = 'frozen-diff:run-a:base-sha:head-sha';
  try {
    assert.ok(await cache.storeContent({ key, data, alias, origin: 'prefetch', cohort: 'run' }));
    transport.setConnection({ connected: false }, 'network');
    assert.deepEqual(await cache.readContentByAlias(alias), data);
    assert.equal((await store.getContent(key))?.origin, 'prefetch');
    assert.deepEqual(await cache.openContentByAlias(alias), data);
    assert.equal((await store.getContent(key))?.origin, 'opened');
    assert.equal(await cache.readContentByAlias('frozen-diff:run-a:base-sha:other'), undefined);
  } finally {
    await cache.dispose();
  }
});

test('the latest alias wins, refused bytes never move it, and eviction removes it', async (t) => {
  const tick = clock(t);
  const { cache, put, byAlias } = fixture(100);
  try {
    tick();
    assert.ok(await put('a', 20, 'prefetch', 'gate', 'x'));
    tick();
    assert.ok(await put('b', 20, 'prefetch', 'gate', 'x'));
    assert.equal(await byAlias('x'), 'b');
    assert.equal(
      await cache.storeContent({
        key: blob('b'.padEnd(20, '.')).key,
        data: encoder.encode('not b'),
        alias: 'x',
        origin: 'prefetch',
        cohort: 'gate',
      }),
      false,
    );
    assert.equal(await byAlias('x'), 'b');
    tick();
    assert.ok(await put('c', 20, 'prefetch', 'gate'));
    assert.equal(await byAlias('x'), 'b');
    tick();
    assert.ok(await put('d', 20, 'prefetch', 'gate'));
    assert.equal(await byAlias('x'), undefined);
    tick();
    assert.ok(await put('b', 20, 'prefetch', 'gate'));
    assert.equal(await byAlias('x'), undefined);
    tick();
    assert.ok(await put('d', 20, 'prefetch', 'gate', 'held'));
    assert.equal(await byAlias('held'), 'd');
  } finally {
    await cache.dispose();
  }
});

function slotDiff(slotId: string) {
  return resourceQuery<{ value: string }>('git.diff', {
    slotId,
    runId: 'run',
    base: 'main',
    target: 'worktree',
    includeUntracked: true,
  });
}
// 40 serialized bytes.
const diffReply = { value: 'x'.repeat(28) };

test('a prefetched slot diff under a full budget cannot evict opened or gate rows', async (t) => {
  const tick = clock(t);
  const { cache, store, transport, put, held } = fixture(100);
  const prefetchDiff = async (slotId: string, cohort: ResourceContentCohort) => {
    const reading = cache.retry(slotDiff(slotId), { origin: 'prefetch', cohort });
    (await transport.nextRead()).resolve(diffReply);
    return reading;
  };
  try {
    tick();
    assert.ok(await put('opened', 50, 'opened', 'run'));
    tick();
    assert.ok(await put('gate', 40, 'prefetch', 'gate'));
    tick();
    assert.deepEqual((await prefetchDiff('slot-a', 'run')).data, diffReply);
    assert.deepEqual(await store.listQueries(), []);
    assert.deepEqual(await held(), ['gate:prefetch:gate', 'opened:opened:run']);
    tick();
    await prefetchDiff('slot-b', 'gate');
    assert.deepEqual(
      (await store.listQueries()).map(({ id, origin, cohort }) => ({ id, origin, cohort })),
      [{ id: slotDiff('slot-b').id, origin: 'prefetch', cohort: 'gate' }],
    );
    assert.deepEqual(await held(), ['opened:opened:run']);
  } finally {
    await cache.dispose();
  }
});

test('prefetched snapshots count toward the prefetch half until a normal read opens them', async (t) => {
  const tick = clock(t);
  const { cache, store, transport, put } = fixture(100);
  const query = slotDiff('slot');
  const read = async (placement?: { origin: 'prefetch'; cohort: ResourceContentCohort }) => {
    const reading = cache.retry(query, placement);
    (await transport.nextRead()).resolve(diffReply);
    await reading;
  };
  const snapshot = async () => {
    const [row] = await store.listQueries();
    return row ? (row.origin ?? 'opened') : 'none';
  };
  try {
    tick();
    await read({ origin: 'prefetch', cohort: 'run' });
    assert.equal(await snapshot(), 'prefetch');
    tick();
    assert.ok(await put('run', 20, 'prefetch', 'run'));
    assert.equal(await snapshot(), 'none');
    tick();
    await read({ origin: 'prefetch', cohort: 'run' });
    tick();
    await read();
    assert.equal(await snapshot(), 'opened');
    tick();
    assert.ok(await put('opened', 40, 'opened', 'run'));
    tick();
    assert.equal(await put('blocked', 30, 'prefetch', 'gate'), false);
    assert.equal(await snapshot(), 'opened');
    tick();
    await read({ origin: 'prefetch', cohort: 'gate' });
    assert.equal(await snapshot(), 'opened');
  } finally {
    await cache.dispose();
  }
});

test('a snapshot observed while its prefetch read is in flight is stored as opened', async () => {
  const { cache, store, transport } = fixture(100);
  const query = slotDiff('slot');
  try {
    const reading = cache.retry(query, { origin: 'prefetch', cohort: 'run' });
    const read = await transport.nextRead();
    const stop = cache.observe(query, () => {});
    read.resolve(diffReply);
    await reading;
    stop();
    assert.deepEqual(
      (await store.listQueries()).map(({ origin }) => origin ?? 'opened'),
      ['opened'],
    );
  } finally {
    await cache.dispose();
  }
});

test('a run blob promoted to the gate survives later run prefetch', async (t) => {
  const tick = clock(t);
  const { cache, transport, put, retain, held } = fixture(100);
  try {
    tick();
    assert.ok(await put('blob', 30, 'prefetch', 'run'));
    tick();
    assert.ok(await retain('blob', { origin: 'prefetch', cohort: 'gate' }));
    assert.deepEqual(await held(), ['blob:prefetch:gate']);
    tick();
    assert.ok(await put('run1', 20, 'prefetch', 'run'));
    tick();
    assert.ok(await put('run2', 20, 'prefetch', 'run'));
    tick();
    assert.equal(await put('run3', 40, 'prefetch', 'run'), false);
    assert.deepEqual(await held(), ['blob:prefetch:gate', 'run2:prefetch:run']);
    assert.equal(await cache.retainContent(blob('not held').key, { cohort: 'gate' }), false);
    const token = cache.contentWriteToken();
    transport.setConnection({ connected: false }, 'network');
    transport.setConnection({ connected: true, id: 2 });
    assert.equal(await retain('run2', { cohort: 'gate', token }), false);
    assert.deepEqual(await held(), ['blob:prefetch:gate', 'run2:prefetch:run']);
    assert.ok(await retain('run2', { origin: 'opened' }));
    assert.deepEqual(await held(), ['blob:prefetch:gate', 'run2:opened:run']);
  } finally {
    await cache.dispose();
  }
});
