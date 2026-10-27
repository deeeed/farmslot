import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { GitDiffResult, Run } from '@farmslot/protocol';
import {
  activeRunDiffQuery,
  type ContentKey,
  createContentPrefetcher,
  createGatewayResourceCache,
  createMemoryResourceStore,
  type GatewayResourceCache,
  gitBlobHash,
  type ResourceCacheConnection,
  type ResourceCacheTransport,
  resourceDependenciesForRead,
  type ResourceQuery,
  type ResourceQueryState,
} from '@farmslot/protocol/client-cache';

import { installFakeGateway } from './testing/fake-gateway.js';

const RUN_DIFF = `diff --git a/src/kept.ts b/src/kept.ts
index 1111111..2222222 100644
--- a/src/kept.ts
+++ b/src/kept.ts
@@ -1 +1 @@
-one
+two
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 90%
rename from src/old-name.ts
rename to src/new-name.ts
index 3333333..4444444 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1 +1,2 @@
 kept
+added
diff --git a/notes/untracked.md b/notes/untracked.md
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/notes/untracked.md
@@ -0,0 +1 @@
+fresh
`;

const run = { id: 'run-a', slotId: 'slot-a', project: 'farm' } as Run;

/** A cache that records what is observed and lets the test emit each state. */
function observingCache() {
  const observed: Array<{
    query: ResourceQuery<GitDiffResult>;
    emit: (state: ResourceQueryState<GitDiffResult>) => void;
    stopped: boolean;
  }> = [];
  const cache: Pick<GatewayResourceCache, 'observe'> = {
    observe<T>(query: ResourceQuery<T>, listener: (state: ResourceQueryState<T>) => void) {
      const entry = {
        query: query as unknown as ResourceQuery<GitDiffResult>,
        emit: (state: ResourceQueryState<GitDiffResult>) =>
          listener(state as unknown as ResourceQueryState<T>),
        stopped: false,
      };
      observed.push(entry);
      listener({ status: 'loading' });
      return () => {
        entry.stopped = true;
      };
    },
  };
  return { cache, observed };
}

async function load(t: TestContext) {
  installFakeGateway(t);
  const { heldRunFileContent, heldRunFileDiff } = await import('./held-run-diff.js');
  const { runProjectDefaultBranch, updateProjectDefaultBranches } = await import('./state.js');
  return {
    heldRunFileContent,
    heldRunFileDiff,
    runProjectDefaultBranch,
    updateProjectDefaultBranches,
  };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const blobId = (text: string) => gitBlobHash(bytes(text));
const ZERO = '0'.repeat(40);
const UNTRACKED = 'line one\nline two\n';
const BASE_TEXT = 'one\ntwo\n';
const NEW_TEXT = 'one\n2\n';
/** As the gateway's active-run diff writes it: `--full-index`, untracked files included. */
const FULL_INDEX_DIFF = [
  'diff --git a/notes/untracked.md b/notes/untracked.md',
  'new file mode 100644',
  `index ${ZERO}..${blobId(UNTRACKED)}`,
  '--- /dev/null',
  '+++ b/notes/untracked.md',
  '@@ -0,0 +1,2 @@',
  '+line one',
  '+line two',
  'diff --git a/src/a.ts b/src/a.ts',
  `index ${blobId(BASE_TEXT)}..${blobId(NEW_TEXT)} 100644`,
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' one',
  '-two',
  '+2',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  `index ${blobId('bye\n')}..${ZERO}`,
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '',
].join('\n');

test('the held run diff is sliced to the path, by either name of a rename and for untracked files', async (t) => {
  const { heldRunFileDiff } = await load(t);
  const read = async (path: string) => {
    const { cache, observed } = observingCache();
    const pending = heldRunFileDiff(cache, run, path);
    observed[0]!.emit({ status: 'stale', data: { diff: RUN_DIFF } });
    const diff = await pending;
    assert.equal(observed[0]!.stopped, true, 'the observation ends once the slice is read');
    return diff;
  };
  assert.match((await read('src/kept.ts')) ?? '', /^diff --git a\/src\/kept\.ts[^]*\+two$/);
  assert.doesNotMatch((await read('src/kept.ts')) ?? '', /new-name|untracked/);
  assert.match((await read('src/new-name.ts')) ?? '', /^diff --git a\/src\/old-name\.ts/);
  assert.match((await read('notes/untracked.md')) ?? '', /\+fresh/);
  assert.equal(await read('src/untouched.ts'), undefined);
});

test('the slice reads the diff prefetch kept: stack base, then the project default branch, then main', async (t) => {
  const { heldRunFileDiff, updateProjectDefaultBranches } = await load(t);
  const base = (target: Run) => {
    const { cache, observed } = observingCache();
    void heldRunFileDiff(cache, target, 'src/kept.ts');
    observed[0]!.emit({ status: 'error', error: { code: 'X', message: 'done' } });
    return observed[0]!.query;
  };
  const expected = (value: string) =>
    activeRunDiffQuery({ slotId: 'slot-a', runId: 'run-a', base: value }).id;
  updateProjectDefaultBranches({});
  assert.equal(base(run).id, expected('main'), 'without the projects, main');
  updateProjectDefaultBranches({ farm: 'develop' });
  assert.equal(base(run).id, expected('develop'), "with them, the project's default branch");
  const stacked = { ...run, stack: { baseBranch: 'feature/parent' } } as Run;
  assert.equal(base(stacked).id, expected('feature/parent'), 'a stack base comes first');
  assert.deepEqual(base(run).params, {
    slotId: 'slot-a',
    runId: 'run-a',
    base: 'develop',
    target: 'worktree',
    includeUntracked: true,
  });
});

test('nothing held waits until aborted; errors and runs off a slot resolve undefined', async (t) => {
  const { heldRunFileDiff } = await load(t);
  const { cache, observed } = observingCache();
  const controller = new AbortController();
  let settled = false;
  const pending = heldRunFileDiff(cache, run, 'src/kept.ts', { signal: controller.signal }).then(
    (diff) => {
      settled = true;
      return diff;
    },
  );
  observed[0]!.emit({ status: 'stale' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'a stored-nothing state keeps waiting');
  controller.abort();
  assert.equal(await pending, undefined);
  assert.equal(observed[0]!.stopped, true);

  const failing = observingCache();
  const failed = heldRunFileDiff(failing.cache, run, 'src/kept.ts');
  failing.observed[0]!.emit({ status: 'unsupported' });
  assert.equal(await failed, undefined);

  const idle = observingCache();
  assert.equal(
    await heldRunFileDiff(idle.cache, { ...run, slotId: null } as Run, 'a.ts'),
    undefined,
  );
  assert.equal(idle.observed.length, 0);
});

test('a quoted file name finds its section: git C-quotes a double quote and non-ASCII bytes', async (t) => {
  const { heldRunFileDiff } = await load(t);
  const quoted = [
    'diff --git "a/docs/say \\"hi\\".md" "b/docs/say \\"hi\\".md"',
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    '+++ "b/docs/say \\"hi\\".md"',
    '@@ -0,0 +1 @@',
    '+hi',
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    'index 2222222..3333333 100644',
    '--- "a/caf\\303\\251.txt"',
    '+++ "b/caf\\303\\251.txt"',
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
  const read = async (path: string) => {
    const { cache, observed } = observingCache();
    const pending = heldRunFileDiff(cache, run, path);
    observed[0]!.emit({ status: 'stale', data: { diff: quoted } });
    return pending;
  };
  assert.match((await read('docs/say "hi".md')) ?? '', /^diff --git "a\/docs\/say [^]*\+hi$/);
  assert.match(
    (await read('café.txt')) ?? '',
    /^diff --git "a\/caf\\303\\251\.txt"[^]*-old\n\+new\n?$/,
  );
});

/** A cache that answers the held run diff and holds the blobs given, without any network. */
function heldCache(diff: string, blobs: Record<string, string>) {
  const opened: string[] = [];
  const read = (key: ContentKey) => {
    const text = key.kind === 'blob' ? blobs[key.id] : undefined;
    return Promise.resolve(text === undefined ? undefined : bytes(text));
  };
  const cache: Pick<GatewayResourceCache, 'observe' | 'openContent' | 'readContent'> = {
    observe<T>(_query: ResourceQuery<T>, listener: (state: ResourceQueryState<T>) => void) {
      listener({ status: 'stale', data: { diff } as T });
      return () => {};
    },
    openContent: (key) => {
      opened.push(key.id);
      return read(key);
    },
    readContent: read,
  };
  return { cache, opened };
}

test('without its blob, a new side is rebuilt from the held diff and base, and kept only when it verifies', async (t) => {
  const { heldRunFileContent } = await load(t);
  const untracked = heldCache(FULL_INDEX_DIFF, {});
  assert.equal(await heldRunFileContent(untracked.cache, run, 'notes/untracked.md'), UNTRACKED);
  const modified = heldCache(FULL_INDEX_DIFF, { [blobId(BASE_TEXT)]: BASE_TEXT });
  assert.equal(await heldRunFileContent(modified.cache, run, 'src/a.ts'), NEW_TEXT);
  assert.equal(
    await heldRunFileContent(heldCache(FULL_INDEX_DIFF, {}).cache, run, 'src/a.ts'),
    undefined,
    'a modified file without its base is not rebuilt',
  );
  const tampered = FULL_INDEX_DIFF.replace('+line two', '+line 2');
  assert.equal(
    await heldRunFileContent(heldCache(tampered, {}).cache, run, 'notes/untracked.md'),
    undefined,
    'a rebuild that does not hash to the new id is refused',
  );
  assert.equal(await heldRunFileContent(untracked.cache, run, 'src/gone.ts'), undefined);
  assert.equal(await heldRunFileContent(untracked.cache, run, 'src/untouched.ts'), undefined);
});

test('an untracked file prefetched by the active-run prefetch opens offline with its content', async (t) => {
  const { heldRunFileContent, runProjectDefaultBranch, updateProjectDefaultBranches } =
    await load(t);
  updateProjectDefaultBranches({ farm: 'develop' });
  const slotRun = { ...run, status: 'monitoring', decisions: [] } as unknown as Run;
  let connection: ResourceCacheConnection = {
    id: 1,
    connected: true,
    authMode: 'token',
    scope: { gatewayUrl: 'ws://held-run.invalid/', principalId: 'owner', principalGeneration: 0 },
    authority: { roles: [], workspaceAccess: 'farm' },
    capabilities: {
      httpBearerAuth: true,
      voiceInstructionFormatting: false,
      batchedContent: true,
      resourceChanges: {
        version: 1,
        epoch: 'held-run',
        versionLists: false,
        workspaceReads: 1,
        observedReads: 1,
      },
    },
  };
  const connections = new Set<(next: ResourceCacheConnection) => void>();
  const reads: Array<{ method: string; params: unknown }> = [];
  const transport: ResourceCacheTransport = {
    getConnection: () => connection,
    onConnectionChange: (listener) => {
      connections.add(listener);
      return () => connections.delete(listener);
    },
    onResourceChanged: () => () => {},
    async request<T>(method: Parameters<ResourceCacheTransport['request']>[0], params: unknown) {
      reads.push({ method, params });
      const data =
        method === 'run.get'
          ? { run: slotRun }
          : { diff: FULL_INDEX_DIFF, mergeBaseSha: 'a'.repeat(40), headSha: 'c'.repeat(40) };
      return {
        data: data as T,
        resourceState: {
          epoch: 'held-run',
          dependencies: (resourceDependenciesForRead(method, params) ?? []).map((key) => ({
            key,
            revision: 0,
          })),
        },
      };
    },
    resynchronize: () => {},
  };
  const store = createMemoryResourceStore();
  const cache = createGatewayResourceCache({ transport, store });
  const prefetcher = createContentPrefetcher({
    transport,
    cache,
    // Only base files of the modified file are shown at the base; nothing else is requested.
    request: async () => ({ entries: [], cursor: undefined, hasMore: false }) as never,
    readArtifact: () => Promise.reject(new Error('no artifacts')),
    defaultBranch: runProjectDefaultBranch,
  });
  try {
    prefetcher.setTargets([{ runId: 'run-a', gate: false }]);
    const untrackedKey = { kind: 'blob' as const, id: blobId(UNTRACKED) };
    for (let turn = 0; turn < 200 && !(await cache.hasContent(untrackedKey)); turn++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await cache.hasContent(untrackedKey), true, 'prefetch held the untracked file');
    assert.equal(
      (reads.find(({ method }) => method === 'git.diff')?.params as { base?: string }).base,
      'develop',
    );

    // Disconnect before the file was ever opened: no fs.read answer exists for it.
    connection = { ...connection, connected: false };
    for (const listener of connections) listener(connection);
    const count = reads.length;
    assert.equal(await heldRunFileContent(cache, slotRun, 'notes/untracked.md'), UNTRACKED);
    assert.equal(reads.length, count, 'opening it offline reads nothing');
    const row = (await store.listContent()).find((entry) => entry.id === untrackedKey.id);
    assert.equal(row?.origin, 'opened');
  } finally {
    prefetcher.dispose();
    await cache.dispose();
  }
});
