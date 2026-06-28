import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDefaultWorktreeTrackingBranch,
  isLinkedGitWorktreeMarker,
  worktreeBaseResetRef,
} from './prepare.js';

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

test('isLinkedGitWorktreeMarker detects linked worktree marker output', () => {
  assert.equal(isLinkedGitWorktreeMarker('linked\n'), true);
  assert.equal(isLinkedGitWorktreeMarker('primary'), false);
});

test('worktreeBaseResetRef prefers resolved startRef sha', () => {
  assert.equal(
    worktreeBaseResetRef('main', {
      requestedRef: 'main',
      resolvedSha: 'abc123def456',
      resolvedAt: '2026-01-01T00:00:00.000Z',
    }),
    'abc123def456',
  );
  assert.equal(worktreeBaseResetRef('main', null), 'origin/main');
});
