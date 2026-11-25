import assert from 'node:assert/strict';
import test from 'node:test';

import { slotRecoveryEligibility, type SlotWorkspace } from '../../src/contracts/slot-recovery.js';
import type { SlotStatus } from '../../src/contracts/slots.js';

const NOW = Date.parse('2026-11-25T10:00:00.000Z');

function busySlot(workspace: Partial<SlotWorkspace>): SlotStatus {
  return {
    slot: 'node-core-2',
    machine: 'node',
    project: 'core',
    platform: 'cli',
    branch: 'fix/run',
    agent: 'idle',
    enabled: true,
    dispatchable: false,
    lifecycle: 'busy',
    phase: null,
    warm: false,
    currentRunId: 'run-1',
    health: { ssh: 'OK', device: '-', devserver: 'OFF', cdp: 'OFF', fixtures: 'OK' },
    taskId: null,
    taskFile: null,
    dispatchedAt: null,
    completedAt: null,
    runner: null,
    model: null,
    deviceName: null,
    taskPhase: null,
    taskStepProgress: null,
    workspace: {
      epoch: 1,
      currentRunId: 'run-1',
      cleanupRunId: null,
      handoffRunId: null,
      branch: 'fix/run',
      headSha: '1'.repeat(40),
      dirtyFingerprint: 'clean',
      recoveryId: null,
      observedAt: new Date(NOW).toISOString(),
      localDefaultSha: '0'.repeat(40),
      defaultFetchedAt: null,
      remoteDefaultSha: '0'.repeat(40),
      remoteObservedAt: null,
      behind: 0,
      remoteAdvanced: false,
      publication: 'baseline',
      dirtyCount: 0,
      unpublishedCount: 0,
      ...workspace,
    },
  };
}

test('a busy slot names its protection instead of a generic busy refusal', () => {
  const reason = 'Execution gw-1 on mini has unconfirmed closeout (disconnected)';
  const result = slotRecoveryEligibility(busySlot({ protectedReason: reason }), NOW);
  assert.equal(result.allowed, false);
  assert.equal(result.bulkInspectable, false);
  assert.equal(result.detail, reason);
});

test('a busy slot without a named protection reads as busy, not as a working agent', () => {
  const result = slotRecoveryEligibility(busySlot({}), NOW);
  assert.equal(result.allowed, false);
  assert.equal(result.detail, 'Slot is busy for an unfinished run');
});
