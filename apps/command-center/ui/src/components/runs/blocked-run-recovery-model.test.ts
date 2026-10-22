import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RuntimeCapabilityStatusResult } from '@farmslot/protocol';

import {
  blockedWorkerOwnsSlot,
  blockedWorkerProofReady,
  isRecoverableBlockedWorkerRun,
} from './blocked-run-recovery-model.js';

const run = {
  id: 'run-1',
  project: 'farmslot-farm',
  slotId: 'macpro-ff-2',
  status: 'blocked',
  metrics: { disposition: 'blocked' },
  decisions: [],
  steps: [
    {
      name: 'monitor',
      status: 'done',
      outputs: {
        workerSignal: { status: 'blocked', attemptId: 'old', timestamp: '2026-09-23T01:00:00Z' },
      },
    },
  ],
  taskFile: '/repo/.sandbox/farmslot-farm/tasks/fix/manual-000110/TASK.md',
  agentContexts: [
    {
      id: 'worker',
      role: 'fix-bug',
      runId: 'run-1',
      signalFile: '.sandbox/farmslot-farm/worker-task/fix/manual-000110/SIGNAL.json',
    },
  ],
} as unknown as Run;

test('recovery follows a blocked worker monitor regardless of project', () => {
  assert.equal(isRecoverableBlockedWorkerRun(run), true);
  assert.equal(isRecoverableBlockedWorkerRun({ ...run, project: 'other' }), true);
  assert.equal(
    isRecoverableBlockedWorkerRun({ ...run, decisions: [{ id: 'pending' }] } as Run),
    false,
  );
  assert.equal(isRecoverableBlockedWorkerRun({ ...run, steps: [] }), false);
  assert.equal(
    isRecoverableBlockedWorkerRun({ ...run, reviewWorkspaceTarget: { machine: 'local' } }),
    false,
  );
});

test('a held review-fix offers recovery even though primary work completed', () => {
  const heldFix: Run = {
    ...run,
    metrics: { ...run.metrics, disposition: 'fixed' },
    steps: [
      { name: 'monitor', status: 'done', outputs: { workerSignal: { status: 'complete' } } },
      {
        name: 'review',
        status: 'done',
        completedAt: '2026-10-22T07:40:58.688Z',
        outputs: { verdict: 'blocked', feedbackSent: true },
      },
    ],
  };
  assert.equal(isRecoverableBlockedWorkerRun(heldFix), true);
  assert.equal(isRecoverableBlockedWorkerRun({ ...heldFix, status: 'reviewing' }), false);
  assert.equal(
    isRecoverableBlockedWorkerRun({
      ...heldFix,
      steps: heldFix.steps.map((step) =>
        step.name === 'review' ? { ...step, outputs: { verdict: 'blocked' } } : step,
      ),
    }),
    false,
    'a blocked reviewer is not a worker fix waiting to resume',
  );
});

test('recovery only acts while the run still owns a slot outside release', () => {
  const slot = { currentRunId: run.id, lifecycle: 'busy', phase: 'working' } as const;
  assert.equal(blockedWorkerOwnsSlot(run, slot), true);
  assert.equal(blockedWorkerOwnsSlot(run, { ...slot, phase: 'releasing' }), false);
  assert.equal(blockedWorkerOwnsSlot(run, { ...slot, currentRunId: 'other' }), false);
  assert.equal(blockedWorkerOwnsSlot(run, { ...slot, lifecycle: 'ready' }), false);
});

test('proof readiness needs an explicit plan and a provider check after the block', () => {
  const blockedRun = {
    ...run,
    steps: [{ ...run.steps[0], completedAt: '2026-09-23T01:00:00Z' }],
  } as Run;
  const status = {
    proofPlans: {
      [run.id]: {
        version: 1,
        slotId: run.slotId,
        ownerRunId: run.id,
        createdAt: '2026-09-23T00:00:00Z',
        requirements: [{ capabilityId: 'browser-cdp', reason: 'proof', mode: 'visual' }],
      },
    },
    leases: [
      {
        capabilityId: 'browser-cdp',
        owner: { runId: run.id },
        state: 'acquired',
        health: { state: 'healthy', checkedAt: '2026-09-23T00:59:00Z' },
      },
    ],
  } as unknown as RuntimeCapabilityStatusResult;
  assert.equal(blockedWorkerProofReady(blockedRun, { ...status, proofPlans: {} }), false);
  assert.equal(
    blockedWorkerProofReady(blockedRun, { ...status, catalog: [], leases: [], proofPlans: {} }),
    true,
  );
  assert.equal(
    blockedWorkerProofReady(blockedRun, {
      ...status,
      proofPlans: { [run.id]: { ...status.proofPlans[run.id], slotId: 'other-slot' } },
    }),
    false,
  );
  assert.equal(blockedWorkerProofReady(blockedRun, status), false);
  status.leases[0].health.checkedAt = '2026-09-23T01:01:00Z';
  assert.equal(blockedWorkerProofReady(blockedRun, status), true);
  status.proofPlans[run.id].requirements = [];
  assert.equal(blockedWorkerProofReady(blockedRun, status), true);
});
