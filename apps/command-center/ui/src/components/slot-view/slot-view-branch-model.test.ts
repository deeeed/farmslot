import assert from 'node:assert/strict';
import test from 'node:test';

import { branchDiffPollAction, slotViewBranchList } from './slot-view-branch-model.js';

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

const POLL_BASE = {
  prevBranch: 'feat/x' as string | undefined,
  nextBranch: 'feat/x',
  prevAhead: 2 as number | undefined,
  nextAhead: 2,
  lastLoadFailed: false,
  loading: false,
};

test('branchDiffPollAction reloads and clears the diff cache on branch change', () => {
  assert.equal(
    branchDiffPollAction({ ...POLL_BASE, nextBranch: 'feat/y' }),
    'reload-and-clear-cache',
  );
});

test('branchDiffPollAction reloads and clears the diff cache when ahead changes', () => {
  assert.equal(branchDiffPollAction({ ...POLL_BASE, nextAhead: 6 }), 'reload-and-clear-cache');
});

test('branchDiffPollAction retries without clearing the cache after a failed load', () => {
  assert.equal(branchDiffPollAction({ ...POLL_BASE, lastLoadFailed: true }), 'reload');
});

test('branchDiffPollAction stays idle while a load is in flight', () => {
  assert.equal(
    branchDiffPollAction({ ...POLL_BASE, lastLoadFailed: true, nextAhead: 6, loading: true }),
    'none',
  );
});

test('branchDiffPollAction stays idle when nothing changed and last load succeeded', () => {
  assert.equal(branchDiffPollAction(POLL_BASE), 'none');
});

test('branchDiffPollAction does not treat the first poll as git movement', () => {
  assert.equal(
    branchDiffPollAction({ ...POLL_BASE, prevBranch: undefined, prevAhead: undefined }),
    'none',
  );
});
