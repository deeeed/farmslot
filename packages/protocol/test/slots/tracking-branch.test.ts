import assert from 'node:assert/strict';
import test from 'node:test';

import {
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

test('isSlotIdleBranch accepts tracking or default branch on linked worktrees', () => {
  assert.equal(isSlotIdleBranch('wt/mm-2', 'wt/mm-2', 'main', true), true);
  assert.equal(isSlotIdleBranch('main', 'wt/ff-2', 'main', true), true);
  assert.equal(isSlotIdleBranch('wt/ff-1', 'wt/ff-2', 'main', true), false);
  assert.equal(isSlotIdleBranch('feat/demo', 'wt/ff-2', 'main', true), false);
});

test('isSlotRefreshStaleBranch uses fleet-probed linkedWorktree signal', () => {
  const project = {
    defaultBranch: 'main',
    slotTrackingBranch: 'wt/{{session}}',
  };
  assert.equal(
    isSlotRefreshStaleBranch('wt/ff-2', project, {
      session: 'ff-2',
      linkedWorktree: true,
    }),
    false,
  );
  assert.equal(
    isSlotRefreshStaleBranch('feat/demo', project, {
      session: 'ff-2',
      linkedWorktree: true,
    }),
    true,
  );
  assert.equal(
    isSlotRefreshStaleBranch('wt/ff-2', project, {
      session: 'ff-2',
      linkedWorktree: false,
    }),
    true,
  );
  assert.equal(
    isSlotRefreshStaleBranch('main', project, { session: 'fs-main', linkedWorktree: false }),
    false,
  );
});