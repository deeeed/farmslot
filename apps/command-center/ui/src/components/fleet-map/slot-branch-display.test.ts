import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { SlotStatus, SlotWorkspace } from '@farmslot/protocol';

import { slotBehindDefaultLabel, slotBranchDisplay } from './slot-branch-display.js';

function slot(overrides: Partial<SlotStatus> & { slot: string }): SlotStatus {
  const { slot: slotId, ...rest } = overrides;
  return {
    slot: slotId,
    machine: 'runner-a',
    project: 'farmslot-farm',
    branch: 'main',
    enabled: true,
    lifecycle: 'ready',
    phase: 'idle',
    currentRunId: '',
    agent: 'idle',
    ...rest,
  } as SlotStatus;
}

const farmslotFarmProject = {
  'farmslot-farm': {
    defaultBranch: 'main',
    slotTrackingBranch: 'wt/{{session}}',
    worktreeBase: '/Users/deeeed/dev/farmslot-wt',
  },
};

test('slotBranchDisplay treats configured tracking branches as baseline', () => {
  const display = slotBranchDisplay(
    slot({
      slot: 'macwork-ff-2',
      branch: 'wt/ff-2',
      session: 'ff-2',
      linkedWorktree: true,
    }),
    farmslotFarmProject,
  );
  assert.equal(display.label, 'wt/ff-2');
  assert.equal(display.tone, 'tracking');
});

function workspace(overrides: Partial<SlotWorkspace>): SlotWorkspace {
  return {
    epoch: 1,
    currentRunId: null,
    cleanupRunId: null,
    handoffRunId: null,
    branch: 'feat/demo',
    headSha: 'abc',
    dirtyFingerprint: '',
    recoveryId: null,
    observedAt: '2026-11-02T00:00:00.000Z',
    defaultBranch: 'develop',
    localDefaultSha: 'abc',
    defaultFetchedAt: null,
    remoteDefaultSha: null,
    remoteObservedAt: null,
    behind: 3,
    remoteAdvanced: false,
    publication: 'pushed',
    dirtyCount: 0,
    unpublishedCount: 0,
    ...overrides,
  };
}

test('slotBehindDefaultLabel shows only a known, non-zero distance', () => {
  assert.equal(slotBehindDefaultLabel({}), '');
  assert.equal(slotBehindDefaultLabel({ workspace: workspace({ behind: null }) }), '');
  assert.equal(slotBehindDefaultLabel({ workspace: workspace({ behind: 0 }) }), '');
  assert.equal(slotBehindDefaultLabel({ workspace: workspace({}) }), '3 behind develop');
  assert.equal(
    slotBehindDefaultLabel({ workspace: workspace({ behind: 0, remoteAdvanced: true }) }),
    '0 behind develop · remote advanced',
  );
});

test('slotBranchDisplay marks feature branches stale', () => {
  const display = slotBranchDisplay(
    slot({ slot: 'stale-1', branch: 'feat/demo' }),
    farmslotFarmProject,
  );
  assert.equal(display.tone, 'stale');
});
