import assert from 'node:assert/strict';
import test from 'node:test';

import { slotViewBranchList } from './slot-view-branch-model.js';

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
