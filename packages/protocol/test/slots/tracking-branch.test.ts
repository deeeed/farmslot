import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isLegacyWorktreeTrackingBranch,
  isRepoUnderWorktreeBase,
  isSlotIdleBranch,
  isSlotRefreshStaleBranch,
  resolveSlotTrackingBranch,
} from '../../src/slots/tracking-branch.js';

test('resolveSlotTrackingBranch uses project template on linked worktrees', () => {
  const branch = resolveSlotTrackingBranch(
    { defaultBranch: 'main', slotTrackingBranch: 'wt/{{session}}' },
    { session: 'ff-2', slotId: 'macwork-ff-2' },
    true,
  );
  assert.equal(branch, 'wt/ff-2');
});

test('resolveSlotTrackingBranch uses default branch on primary clones', () => {
  const branch = resolveSlotTrackingBranch(
    { defaultBranch: 'main', slotTrackingBranch: 'wt/{{session}}' },
    { session: 'fs-main' },
    false,
  );
  assert.equal(branch, 'main');
});

test('isSlotIdleBranch accepts configured tracking branch and legacy names', () => {
  assert.equal(isSlotIdleBranch('wt/mm-2', 'wt/mm-2', 'main', true), true);
  assert.equal(isSlotIdleBranch('wt/ff-1', 'wt/ff-2', 'main', true), true);
  assert.equal(isSlotIdleBranch('feat/demo', 'wt/ff-2', 'main', true), false);
});

test('isRepoUnderWorktreeBase detects worktree sandboxes from project config', () => {
  const base = '/Users/deeeed/dev/farmslot-wt';
  assert.equal(isRepoUnderWorktreeBase(`${base}/farmslot-2`, base), true);
  assert.equal(isRepoUnderWorktreeBase('/Users/deeeed/dev/farmslot', base), false);
});

test('isSlotRefreshStaleBranch uses worktree_base instead of hardcoded branch patterns', () => {
  const project = {
    defaultBranch: 'main',
    slotTrackingBranch: 'wt/{{session}}',
    worktreeBase: '/Users/deeeed/dev/farmslot-wt',
  };
  assert.equal(
    isSlotRefreshStaleBranch(
      'wt/ff-2',
      project,
      { session: 'ff-2', repo: '/Users/deeeed/dev/farmslot-wt/farmslot-2' },
    ),
    false,
  );
  assert.equal(
    isSlotRefreshStaleBranch(
      'feat/demo',
      project,
      { session: 'ff-2', repo: '/Users/deeeed/dev/farmslot-wt/farmslot-2' },
    ),
    true,
  );
  assert.equal(
    isSlotRefreshStaleBranch('main', project, { session: 'fs-main', repo: '/Users/deeeed/dev/farmslot' }),
    false,
  );
});

test('isLegacyWorktreeTrackingBranch remains a narrow compatibility shim', () => {
  assert.equal(isLegacyWorktreeTrackingBranch('wt/ff-2'), true);
  assert.equal(isLegacyWorktreeTrackingBranch('wt/mm-2'), false);
});