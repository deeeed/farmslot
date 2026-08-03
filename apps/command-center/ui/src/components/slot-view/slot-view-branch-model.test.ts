import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldReloadBranchDiff, slotViewBranchList } from './slot-view-branch-model.js';

test('slotViewBranchList includes default and active branch candidates', () => {
  assert.deepEqual(
    slotViewBranchList({
      branchDiffBase: 'origin/main',
      branchDiffHead: 'feature/ui-cleanup',
      gitBranch: 'feature/worktree',
    }),
    ['develop', 'feature/ui-cleanup', 'feature/worktree', 'main', 'origin/main'],
  );
});

test('slotViewBranchList deduplicates main and empty candidates', () => {
  assert.deepEqual(
    slotViewBranchList({ branchDiffBase: 'main', branchDiffHead: '', gitBranch: undefined }),
    ['develop', 'main'],
  );
});

const RELOAD_BASE = {
  prevBranch: 'feat/x' as string | undefined,
  nextBranch: 'feat/x',
  prevAhead: 2 as number | undefined,
  nextAhead: 2,
  lastLoadFailed: false,
  loading: false,
};

test('shouldReloadBranchDiff reloads on branch change', () => {
  assert.equal(shouldReloadBranchDiff({ ...RELOAD_BASE, nextBranch: 'feat/y' }), true);
});

test('shouldReloadBranchDiff reloads when the ahead count changes (new commits)', () => {
  assert.equal(shouldReloadBranchDiff({ ...RELOAD_BASE, nextAhead: 6 }), true);
});

test('shouldReloadBranchDiff retries after a failed load even with no git movement', () => {
  assert.equal(shouldReloadBranchDiff({ ...RELOAD_BASE, lastLoadFailed: true }), true);
});

test('shouldReloadBranchDiff stays idle while a load is in flight', () => {
  assert.equal(
    shouldReloadBranchDiff({ ...RELOAD_BASE, lastLoadFailed: true, nextAhead: 6, loading: true }),
    false,
  );
});

test('shouldReloadBranchDiff stays idle when nothing changed and last load succeeded', () => {
  assert.equal(shouldReloadBranchDiff(RELOAD_BASE), false);
});

test('shouldReloadBranchDiff does not treat the first poll as a change', () => {
  assert.equal(
    shouldReloadBranchDiff({ ...RELOAD_BASE, prevBranch: undefined, prevAhead: undefined }),
    false,
  );
});
