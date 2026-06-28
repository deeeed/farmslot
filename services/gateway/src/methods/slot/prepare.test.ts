import assert from 'node:assert/strict';
import test from 'node:test';

import { isDefaultWorktreeTrackingBranch } from './prepare.js';

test('isDefaultWorktreeTrackingBranch only allows farmslot ff worktree branches', () => {
  assert.equal(isDefaultWorktreeTrackingBranch('wt/ff-1'), true);
  assert.equal(isDefaultWorktreeTrackingBranch('wt/ff-2'), true);
  assert.equal(isDefaultWorktreeTrackingBranch('wt/ff-demo_1'), true);

  assert.equal(isDefaultWorktreeTrackingBranch('main'), false);
  assert.equal(isDefaultWorktreeTrackingBranch('feature/demo'), false);
  assert.equal(isDefaultWorktreeTrackingBranch('wt/mm-1'), false);
  assert.equal(isDefaultWorktreeTrackingBranch('wt/ff-1/extra'), false);
  assert.equal(isDefaultWorktreeTrackingBranch('scratch'), false);
});
