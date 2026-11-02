import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test, type TestContext } from 'node:test';

// Hold a real read after it captures bytes, so invalidation and the replacement
// write happen before that read finishes. No filesystem scheduling assumption.
let heldPath: string | undefined;
let holdNextRead: (() => Promise<void>) | undefined;
const readFile = fs.readFile;
mock.module('node:fs/promises', {
  namedExports: {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await readFile(...args);
      if (args[0] === heldPath && holdNextRead) {
        const hold = holdNextRead;
        holdNextRead = undefined;
        await hold();
      }
      return bytes;
    },
  },
});

const { attachLiveRecipeContext, invalidateArtifactTextCache, invalidateLiveRecipeContextMemo } =
  await import('./context.js');
const { makeRun } = await import('./test-fixtures.js');

async function pausedRecipeRead(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000 });
  const root = await fs.mkdtemp(path.join(tmpdir(), 'farmslot-cache-race-'));
  const artifacts = path.join(root, 'artifacts');
  await fs.mkdir(artifacts);
  const recipePath = path.join(artifacts, 'recipe.json');
  await fs.writeFile(path.join(root, 'TASK.md'), '# task\n');
  await fs.writeFile(recipePath, '{"entry":"BEFORE_INVALIDATE"}\n');
  const run = makeRun(path.join(root, 'TASK.md'), { id: root, slotId: null });
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(async () => {
    release();
    heldPath = undefined;
    holdNextRead = undefined;
    invalidateArtifactTextCache();
    invalidateLiveRecipeContextMemo();
    await fs.rm(root, { recursive: true, force: true });
  });
  heldPath = recipePath;
  holdNextRead = () => {
    markStarted();
    return released;
  };
  const stale = attachLiveRecipeContext(run);
  await started;
  return { run, artifacts, recipePath, stale, release };
}

for (const scope of ['all', 'prefix', 'slot'] as const) {
  test(`inflight load racing ${scope} invalidate must not repopulate the memo with stale value`, async (t) => {
    const { run, artifacts, recipePath, stale, release } = await pausedRecipeRead(t);
    invalidateLiveRecipeContextMemo(run.id);
    if (scope === 'all') invalidateArtifactTextCache();
    else if (scope === 'prefix') invalidateArtifactTextCache(artifacts);
    else invalidateArtifactTextCache(artifacts, run.slotId);
    await fs.writeFile(recipePath, '{"entry":"AFTER_INVALIDATE"}\n');
    release();
    assert.equal((await stale).liveRecipeContext?.recipeJson, '{"entry":"BEFORE_INVALIDATE"}\n');
    const fresh = await attachLiveRecipeContext(run);
    assert.equal(
      fresh.liveRecipeContext?.recipeJson,
      '{"entry":"AFTER_INVALIDATE"}\n',
      'an invalidated file read must not refill the file cache beneath the run memo',
    );
  });
}

test('an older load completing after a replacement cannot overwrite its cached file', async (t) => {
  const { run, recipePath, stale, release } = await pausedRecipeRead(t);
  invalidateLiveRecipeContextMemo(run.id);
  invalidateArtifactTextCache();
  await fs.writeFile(recipePath, '{"entry":"AFTER_INVALIDATE"}\n');
  assert.equal(
    (await attachLiveRecipeContext(run)).liveRecipeContext?.recipeJson,
    '{"entry":"AFTER_INVALIDATE"}\n',
  );
  release();
  await stale;
  // Expire only the one-second run memo. The five-second file cache must still
  // contain the replacement value, even after the older read completed last.
  t.mock.timers.tick(1_001);
  assert.equal(
    (await attachLiveRecipeContext(run)).liveRecipeContext?.recipeJson,
    '{"entry":"AFTER_INVALIDATE"}\n',
  );
});
