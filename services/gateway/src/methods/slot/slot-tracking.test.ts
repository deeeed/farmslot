import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotVars } from '../../core/config.js';

import {
  isDefaultWorktreeTrackingBranch,
  isLinkedGitWorktreeMarker,
  isSlotIdleBranch,
  resolveMergeMainStrategy,
  resolveSlotTrackingBranch,
  resolveSlotTrackingBranchFromProject,
  slotIdleResetStepDetail,
  worktreeBaseResetRef,
} from './slot-tracking.js';

function testSlotVars(overrides: Partial<SlotVars> & Pick<SlotVars, 'slotId' | 'session'>): SlotVars {
  return {
    machine: 'macwork',
    platform: 'macos',
    host: 'localhost',
    sshUser: 'deeeed',
    osType: 'darwin',
    claudePath: '',
    codexPath: '',
    opencodePath: '',
    cursorPath: '',
    grokPath: '',
    dispatchCmd: '',
    recycleCmd: '',
    repo: overrides.remoteRepo ?? '/tmp/repo',
    remoteRepo: overrides.remoteRepo ?? '/tmp/repo',
    slotMode: 'dispatch',
    slotEnabled: true,
    sshTarget: 'localhost',
    projectName: 'farmslot-farm',
    resourceVars: {},
    ...overrides,
  };
}

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

test('resolveSlotTrackingBranch uses project template on linked worktrees', () => {
  const branch = resolveSlotTrackingBranch(
    { slotTrackingBranch: 'wt/{{session}}' },
    { session: 'ff-2', slotId: 'macwork-ff-2' },
    true,
  );
  assert.equal(branch, 'wt/ff-2');
});

test('resolveSlotTrackingBranchFromProject expands project.json templates via gateway hooks', () => {
  const branch = resolveSlotTrackingBranchFromProject(
    { slot_tracking_branch: 'wt/{{session}}' },
    testSlotVars({ slotId: 'macwork-ff-2', session: 'ff-2' }),
    undefined,
    true,
  );
  assert.equal(branch, 'wt/ff-2');
});

test('resolveSlotTrackingBranch falls back to wt/session when template omitted', () => {
  const branch = resolveSlotTrackingBranch(
    {},
    { session: 'ff-3', slotId: 'macwork-ff-3' },
    true,
  );
  assert.equal(branch, 'wt/ff-3');
});

test('resolveSlotTrackingBranch uses default branch on primary clones', () => {
  const branch = resolveSlotTrackingBranch(
    { defaultBranch: 'main', slotTrackingBranch: 'wt/{{session}}' },
    { session: 'fs-main', slotId: 'macwork-fs-main' },
    false,
  );
  assert.equal(branch, 'main');
});

test('isSlotIdleBranch accepts tracking branch or legacy wt/ff on linked worktrees', () => {
  assert.equal(isSlotIdleBranch('wt/ff-2', 'wt/ff-2', 'main', true), true);
  assert.equal(isSlotIdleBranch('wt/ff-2', 'wt/mm-2', 'main', true), true);
  assert.equal(isSlotIdleBranch('feat/demo', 'wt/ff-2', 'main', true), false);
  assert.equal(isSlotIdleBranch('main', 'wt/ff-2', 'main', true), true);
});

test('resolveMergeMainStrategy honors override then project config', () => {
  assert.equal(resolveMergeMainStrategy({}, 'rebase'), 'rebase');
  assert.equal(resolveMergeMainStrategy({ merge_main_strategy: 'rebase' }), 'rebase');
  assert.equal(resolveMergeMainStrategy({}), 'merge');
});

test('slotIdleResetStepDetail describes linked worktree idle state', () => {
  assert.equal(
    slotIdleResetStepDetail(
      { trackingBranch: 'wt/ff-2', previousBranch: 'feat/demo', linkedWorktree: true },
      'main',
    ),
    'Returned to wt/ff-2 @ origin/main (was feat/demo)',
  );
  assert.equal(
    slotIdleResetStepDetail(
      { trackingBranch: 'main', previousBranch: 'feat/demo', linkedWorktree: false },
      'main',
    ),
    'Returned to main @ origin/main (was feat/demo)',
  );
});