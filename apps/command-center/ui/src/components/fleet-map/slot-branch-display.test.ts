import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import { slotBranchDisplay } from './slot-branch-display.js';

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

test('slotBranchDisplay marks feature branches stale', () => {
  const display = slotBranchDisplay(
    slot({ slot: 'stale-1', branch: 'feat/demo' }),
    farmslotFarmProject,
  );
  assert.equal(display.tone, 'stale');
});