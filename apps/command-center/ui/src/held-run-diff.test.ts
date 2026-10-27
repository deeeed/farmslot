import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import type { GitDiffResult, Run } from '@farmslot/protocol';
import {
  activeRunDiffQuery,
  type GatewayResourceCache,
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
  const { heldRunFileDiff } = await import('./held-run-diff.js');
  const { updateProjectDefaultBranches } = await import('./state.js');
  return { heldRunFileDiff, updateProjectDefaultBranches };
}

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
