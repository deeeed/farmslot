import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  attachLiveRecipeContext,
  invalidateArtifactTextCache,
  invalidateLiveRecipeContextMemo,
} from './context.js';
import { makeRun } from './test-fixtures.js';

// ─── Cache + memo tests for the slot-panel-open WS chatter reduction ───
//
// Module-level caches persist across tests; each test below uses a unique
// run.id and clears caches in t.after to avoid cross-test pollution.

async function makeRunWithRecipe(
  t: TestContext,
  runId: string,
): Promise<{ run: Run; recipePath: string; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-cache-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    invalidateArtifactTextCache();
    invalidateLiveRecipeContextMemo();
  });
  const taskDir = path.join(root, 'tasks', runId);
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  const recipePath = path.join(artifactsDir, 'recipe.json');
  await writeFile(recipePath, '{"entry":"start"}\n', 'utf-8');
  return {
    run: makeRun(path.join(taskDir, 'TASK.md'), { id: runId, slotId: null }),
    recipePath,
    root,
  };
}

test('attachLiveRecipeContext memo collapses concurrent callers within the burst window', async (t) => {
  const { run, recipePath } = await makeRunWithRecipe(t, 'run-memo-1');
  // Five concurrent callers (mimics run.get + runForSlot + recipeListGroups +
  // runRecipeRunsForSlot + fsServeRunArtifact firing in parallel on panel open).
  // Inflight dedup must collapse them all into one underlying load — we verify
  // by deleting the recipe AFTER the first call resolves but before the others
  // complete: cached value would still surface for the dedup'd callers.
  const results = await Promise.all([
    attachLiveRecipeContext(run),
    attachLiveRecipeContext(run),
    attachLiveRecipeContext(run),
    attachLiveRecipeContext(run),
    attachLiveRecipeContext(run),
  ]);
  for (const r of results) assert.equal(r.liveRecipeContext?.recipeJson, '{"entry":"start"}\n');

  // Within memo TTL (1s): a follow-up call should still return cached context
  // EVEN WITH the file deleted, proving the memo short-circuited the load.
  await unlink(recipePath);
  const cached = await attachLiveRecipeContext(run);
  assert.equal(
    cached.liveRecipeContext?.recipeJson,
    '{"entry":"start"}\n',
    'memo serves cached value despite file deletion',
  );
});

test('attachLiveRecipeContext memo expires after TTL and re-loads', async (t) => {
  const { run, recipePath } = await makeRunWithRecipe(t, 'run-memo-2');
  const first = await attachLiveRecipeContext(run);
  assert.equal(first.liveRecipeContext?.recipeJson, '{"entry":"start"}\n');

  // Wait > 1s memo TTL AND > 5s file-cache TTL so both layers expire.
  // After both expire, deletion is observed — recipe disappears from context.
  await unlink(recipePath);
  invalidateArtifactTextCache(); // simulate file-cache TTL elapse without sleeping 5s
  invalidateLiveRecipeContextMemo(run.id); // simulate memo TTL elapse without sleeping 1s
  const after = await attachLiveRecipeContext(run);
  // recipe.json gone → loadLiveRecipeContextForRun returns null context.
  assert.equal(
    after.liveRecipeContext,
    null,
    'after both caches expire and the file is deleted, context reflects reality',
  );
});

test('artifact text cache short-circuits subsequent reads of the same file (positive entry)', async (t) => {
  const { run, recipePath } = await makeRunWithRecipe(t, 'run-cache-1');
  const first = await attachLiveRecipeContext(run);
  assert.equal(first.liveRecipeContext?.recipeJson, '{"entry":"start"}\n');

  // Force the memo to miss so we hit loadLiveRecipeContextForRun again, but
  // leave the file cache warm. Delete the file: if the file cache hit, we
  // STILL see the cached recipe; if not, we'd see null.
  invalidateLiveRecipeContextMemo(run.id);
  await unlink(recipePath);
  const cached = await attachLiveRecipeContext(run);
  assert.equal(
    cached.liveRecipeContext?.recipeJson,
    '{"entry":"start"}\n',
    'file cache served the deleted file from memory',
  );
});

test('artifact text cache caches negative results — missing files are not re-fetched', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-neg-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    invalidateArtifactTextCache();
    invalidateLiveRecipeContextMemo();
  });
  const taskDir = path.join(root, 'tasks', 'run-cache-2');
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  // No recipe.json — first call seeds a negative cache entry.
  const run = makeRun(path.join(taskDir, 'TASK.md'), { id: 'run-cache-2', slotId: null });
  const first = await attachLiveRecipeContext(run);
  assert.equal(first.liveRecipeContext, null);

  // Now create the file — but without invalidating the negative cache, the
  // next read within TTL still sees null.
  await writeFile(path.join(artifactsDir, 'recipe.json'), '{"entry":"new"}\n', 'utf-8');
  invalidateLiveRecipeContextMemo(run.id); // bust memo, but keep artifact cache
  const stillCached = await attachLiveRecipeContext(run);
  assert.equal(
    stillCached.liveRecipeContext,
    null,
    'negative cache held: new file invisible until TTL or invalidate',
  );

  // Invalidate the artifact cache and the new file becomes visible.
  invalidateArtifactTextCache();
  invalidateLiveRecipeContextMemo(run.id);
  const after = await attachLiveRecipeContext(run);
  assert.equal(after.liveRecipeContext?.recipeJson, '{"entry":"new"}\n');
});

test('invalidateArtifactTextCache(prefix) only clears entries under the given root', async (t) => {
  const { run: runA, recipePath: recipePathA } = await makeRunWithRecipe(t, 'run-invalidate-a');
  const { run: runB } = await makeRunWithRecipe(t, 'run-invalidate-b');

  await attachLiveRecipeContext(runA);
  await attachLiveRecipeContext(runB);

  // Delete A's recipe and invalidate ONLY A's prefix; B's cache must survive.
  await unlink(recipePathA);
  invalidateLiveRecipeContextMemo(runA.id);
  invalidateLiveRecipeContextMemo(runB.id);
  const artifactsRootA = path.join(path.dirname(runA.taskFile!), 'artifacts');
  invalidateArtifactTextCache(artifactsRootA);

  const afterA = await attachLiveRecipeContext(runA);
  assert.equal(
    afterA.liveRecipeContext,
    null,
    'A re-read sees deletion (its cache was invalidated)',
  );

  const afterB = await attachLiveRecipeContext(runB);
  assert.equal(
    afterB.liveRecipeContext?.recipeJson,
    '{"entry":"start"}\n',
    'B served from cache (its prefix was untouched)',
  );
});

test('invalidateArtifactTextCache(prefix) does not false-positive on sibling paths sharing a stem', async (t) => {
  // Reviewer P2: `'/foo/barbaz'.startsWith('/foo/bar')` is `true`. Build two
  // sibling artifact roots that share a path stem and verify invalidating one
  // does NOT wipe the other. Required isPathWithinBase semantics, not startsWith.
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-prefix-fp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    invalidateArtifactTextCache();
    invalidateLiveRecipeContextMemo();
  });

  async function buildRunAt(taskName: string, runId: string): Promise<Run> {
    const taskDir = path.join(root, 'tasks', taskName);
    const artifactsDir = path.join(taskDir, 'artifacts');
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
    await writeFile(path.join(artifactsDir, 'recipe.json'), `{"entry":"${taskName}"}\n`, 'utf-8');
    return makeRun(path.join(taskDir, 'TASK.md'), { id: runId, slotId: null });
  }

  // Sibling task names with shared stem: 'run-foo' and 'run-foo-bar'.
  const runShort = await buildRunAt('run-foo', 'run-foo-id');
  const runLong = await buildRunAt('run-foo-bar', 'run-foo-bar-id');

  await attachLiveRecipeContext(runShort);
  await attachLiveRecipeContext(runLong);

  // Invalidate ONLY the short prefix '.../tasks/run-foo/artifacts'. A naive
  // startsWith check would also clear '.../tasks/run-foo-bar/artifacts'.
  invalidateLiveRecipeContextMemo(runShort.id);
  invalidateLiveRecipeContextMemo(runLong.id);
  invalidateArtifactTextCache(path.join(root, 'tasks', 'run-foo', 'artifacts'));

  // Long-stem run's cache must still serve the original value even after deletion.
  await unlink(path.join(root, 'tasks', 'run-foo-bar', 'artifacts', 'recipe.json'));
  const afterLong = await attachLiveRecipeContext(runLong);
  assert.equal(
    afterLong.liveRecipeContext?.recipeJson,
    '{"entry":"run-foo-bar"}\n',
    'sibling-stem run should not be invalidated by the shorter prefix',
  );
});

test('invalidateLiveRecipeContextMemo also clears the inflight entry to avoid stale-await', async (t) => {
  // If a load is in flight when invalidate runs, a fresh caller arriving after
  // invalidate must not piggyback on the about-to-be-stale promise.
  const { run, recipePath } = await makeRunWithRecipe(t, 'run-inflight-invalidate');
  // First call kicks off a load and seeds the cache.
  const first = await attachLiveRecipeContext(run);
  assert.equal(first.liveRecipeContext?.recipeJson, '{"entry":"start"}\n');

  // Now mutate the file underneath the cache and call invalidate. The next
  // call should hit a fresh load and pick up the new content.
  await writeFile(recipePath, '{"entry":"new-value"}\n', 'utf-8');
  invalidateArtifactTextCache();
  invalidateLiveRecipeContextMemo(run.id);

  const after = await attachLiveRecipeContext(run);
  assert.equal(
    after.liveRecipeContext?.recipeJson,
    '{"entry":"new-value"}\n',
    'invalidate clears both memo and any inflight; next call sees the fresh write',
  );
});

test('artifact text cache keys by slotId so two slots sharing a path do not poison each other', async (t) => {
  // Reviewer P1: two remote slots on different machines can have identical
  // artifact paths (`~/dev/example-app/.../tasks/.../artifacts/recipe.json`) but
  // resolve to different content via per-slot node WS. A cache keyed only by
  // path would let slotA's read serve as slotB's read for up to 5s.
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-slot-isolation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    invalidateArtifactTextCache();
    invalidateLiveRecipeContextMemo();
  });

  // Build ONE artifacts dir on disk — both runs claim the same taskFile path,
  // but each is "owned" by a different slotId. Local paths exist for the
  // shouldPreferLocalPortableArtifacts fast path; real machines would diverge.
  const taskDir = path.join(root, 'tasks', 'shared-path');
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(path.join(artifactsDir, 'recipe.json'), '{"entry":"slot-a-content"}\n', 'utf-8');

  const taskFile = path.join(taskDir, 'TASK.md');
  const runSlotA = makeRun(taskFile, { id: 'run-slot-iso-a', slotId: 'runner-local-slot-a' });
  const runSlotB = makeRun(taskFile, { id: 'run-slot-iso-b', slotId: 'mini-slot-b' });

  // Slot A reads first → seeds cache under key `runner-local-slot-a|<path>`.
  const a1 = await attachLiveRecipeContext(runSlotA);
  assert.equal(a1.liveRecipeContext?.recipeJson, '{"entry":"slot-a-content"}\n');

  // Mutate the file to simulate divergent slot content. With a path-only
  // cache, slot B would get the stale slot-a-content from cache. With
  // slot-keyed cache, slot B does its own read and sees the new value.
  await writeFile(path.join(artifactsDir, 'recipe.json'), '{"entry":"slot-b-content"}\n', 'utf-8');
  const b1 = await attachLiveRecipeContext(runSlotB);
  assert.equal(
    b1.liveRecipeContext?.recipeJson,
    '{"entry":"slot-b-content"}\n',
    "slot B must read its own value, not slot A's cached entry under the same path",
  );

  // Slot-scoped invalidate: only slot A's entries should drop.
  invalidateLiveRecipeContextMemo(runSlotA.id);
  invalidateArtifactTextCache(artifactsDir, runSlotA.slotId);
  // Slot B's memo + cache survive.
  invalidateLiveRecipeContextMemo(runSlotB.id); // bust memo only — cache should hold
  const b2 = await attachLiveRecipeContext(runSlotB);
  assert.equal(
    b2.liveRecipeContext?.recipeJson,
    '{"entry":"slot-b-content"}\n',
    'slot B file cache survives the slot-scoped slot-A invalidation',
  );
});

test('inflight load racing invalidate must not repopulate the memo with stale value', async (t) => {
  // Reviewer P1: when invalidateLiveRecipeContextMemo runs while a load is
  // mid-flight, the originating caller's `liveContextResultCache.set` must NOT
  // re-poison the cache the invalidation just cleared. The guard at line 619
  // only writes if the inflight slot is still ours.
  const { run, recipePath } = await makeRunWithRecipe(t, 'run-race-guard');

  // Kick off the load — keep the promise in flight (no await yet).
  const inflightPromise = attachLiveRecipeContext(run);

  // While that load is parked on the await, invalidate. This clears both the
  // memo and the inflight slot. The original load is still running but its
  // post-await write should be a no-op now.
  invalidateLiveRecipeContextMemo(run.id);
  invalidateArtifactTextCache();

  // Mutate the source so a fresh load would return different content.
  await unlink(recipePath);
  await writeFile(recipePath, '{"entry":"AFTER_INVALIDATE"}\n', 'utf-8');

  // Drain the original in-flight load. Without the race guard, this would
  // re-populate liveContextResultCache with the pre-invalidation snapshot.
  await inflightPromise;

  // A fresh call must NOT see a stale memo. With the race guard, the memo
  // was never repopulated → fresh load runs → reads the new value.
  const fresh = await attachLiveRecipeContext(run);
  assert.equal(
    fresh.liveRecipeContext?.recipeJson,
    '{"entry":"AFTER_INVALIDATE"}\n',
    'memo must not be re-poisoned by the completing in-flight load after invalidation',
  );
});

test('cache key uses NUL separator + sentinel — slotId literally named "local" does not collide with null', async (t) => {
  // L1: previous separator was `|` and null sentinel was `'local'`. A real slot
  // literally named 'local' would have collided with null-slot reads. Verify
  // the NUL + __null__ scheme keeps them isolated.
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-sentinel-collision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => {
    invalidateArtifactTextCache();
    invalidateLiveRecipeContextMemo();
  });

  const taskDir = path.join(root, 'tasks', 'sentinel-collision');
  const artifactsDir = path.join(taskDir, 'artifacts');
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(path.join(taskDir, 'TASK.md'), '# task\n', 'utf-8');
  await writeFile(
    path.join(artifactsDir, 'recipe.json'),
    '{"entry":"slot-named-local"}\n',
    'utf-8',
  );

  const taskFile = path.join(taskDir, 'TASK.md');
  // One run with slotId === 'local' (real slot), one with slotId === null.
  // Same artifact path. Without the sentinel they'd collide.
  const runRealLocal = makeRun(taskFile, { id: 'run-real-local', slotId: 'local' });
  const runNull = makeRun(taskFile, { id: 'run-null-slot', slotId: null });

  // Real-local slot reads first → cache key `local\0<path>`.
  const a = await attachLiveRecipeContext(runRealLocal);
  assert.equal(a.liveRecipeContext?.recipeJson, '{"entry":"slot-named-local"}\n');

  // Mutate file. Null-slot run must do its own read (cache key `__null__\0<path>`,
  // distinct from `local\0<path>`).
  await writeFile(path.join(artifactsDir, 'recipe.json'), '{"entry":"null-slot"}\n', 'utf-8');
  const b = await attachLiveRecipeContext(runNull);
  assert.equal(
    b.liveRecipeContext?.recipeJson,
    '{"entry":"null-slot"}\n',
    'null-slot run reads independently from a real slot literally named "local"',
  );

  // Slot-scoped invalidate of 'local' must not affect null-slot's cache.
  invalidateLiveRecipeContextMemo(runNull.id);
  invalidateArtifactTextCache(artifactsDir, 'local');
  const b2 = await attachLiveRecipeContext(runNull);
  assert.equal(
    b2.liveRecipeContext?.recipeJson,
    '{"entry":"null-slot"}\n',
    'null-slot cache survives slot-scoped invalidation of literal-name slot "local"',
  );
});

test('attachLiveRecipeContext keeps memos for different run.ids isolated', async (t) => {
  const { run: runA } = await makeRunWithRecipe(t, 'run-iso-a');
  const { run: runB } = await makeRunWithRecipe(t, 'run-iso-b');

  // Burst on both runs in parallel — each should get its own load + memo.
  const [a1, b1, a2, b2] = await Promise.all([
    attachLiveRecipeContext(runA),
    attachLiveRecipeContext(runB),
    attachLiveRecipeContext(runA),
    attachLiveRecipeContext(runB),
  ]);
  assert.equal(a1.id, runA.id);
  assert.equal(b1.id, runB.id);
  assert.equal(a2.id, runA.id);
  assert.equal(b2.id, runB.id);
  assert.equal(a1.liveRecipeContext?.recipeJson, '{"entry":"start"}\n');
  assert.equal(b1.liveRecipeContext?.recipeJson, '{"entry":"start"}\n');

  // Invalidating only runA's memo must not affect runB's.
  invalidateLiveRecipeContextMemo(runA.id);
  // runB still memo-hits within TTL.
  const stillCached = await attachLiveRecipeContext(runB);
  assert.equal(stillCached.liveRecipeContext?.recipeJson, '{"entry":"start"}\n');
});
