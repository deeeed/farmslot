import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run, RuntimeCapabilityStatusResult } from '@farmslot/protocol';

import {
  blockedWorkerOwnsSlot,
  blockedWorkerProofReady,
  canResumeBlockedWorkerMonitor,
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
      outputs: { workerSignal: { attemptId: 'old', timestamp: '2026-09-23T01:00:00Z' } },
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
});

test('monitor replay requires a fresh timestamped non-blocked worker signal', () => {
  const timestamp = '2026-09-23T01:01:00Z';
  assert.equal(canResumeBlockedWorkerMonitor(run, { attemptId: 'new', status: 'running' }), false);
  assert.equal(
    canResumeBlockedWorkerMonitor(run, {
      attemptId: 'new',
      timestamp: '2026-09-23T01:00:00Z',
      status: 'running',
    }),
    false,
  );
  assert.equal(
    canResumeBlockedWorkerMonitor(run, { attemptId: 'new', timestamp, status: 'blocked' }),
    false,
  );
  assert.equal(
    canResumeBlockedWorkerMonitor(run, { attemptId: 'new', timestamp, status: 'running' }),
    true,
  );
  assert.equal(
    canResumeBlockedWorkerMonitor(run, { attemptId: 'new', timestamp, status: 'complete' }),
    true,
  );
  assert.equal(
    canResumeBlockedWorkerMonitor(run, {
      attemptId: 'new',
      timestamp,
      status: 'running',
      contextId: 'other',
    }),
    false,
  );
  assert.equal(
    canResumeBlockedWorkerMonitor(run, {
      attemptId: 'new',
      timestamp,
      status: 'running',
      role: 'self-review',
    }),
    false,
  );
  assert.equal(
    canResumeBlockedWorkerMonitor(
      {
        ...run,
        steps: [
          {
            name: 'monitor',
            status: 'done',
            outputs: { workerSignal: { attemptId: 'old', timestamp: '2026-09-23T01:00:00Z' } },
          },
        ],
      } as Run,
      { attemptId: 'old', timestamp: '2026-09-23T01:01:00Z', status: 'complete' },
    ),
    false,
  );
  assert.equal(
    canResumeBlockedWorkerMonitor({ ...run, steps: [{ name: 'monitor', status: 'done' }] } as Run, {
      attemptId: 'new',
      status: 'running',
    }),
    false,
  );
  assert.equal(
    canResumeBlockedWorkerMonitor(
      {
        ...run,
        steps: [
          {
            name: 'monitor',
            status: 'done',
            outputs: { workerSignal: { timestamp: '2026-09-23T01:00:00Z' } },
          },
        ],
      } as Run,
      { timestamp: '2026-09-23T01:01:00Z', status: 'running' },
    ),
    false,
  );
  assert.equal(
    canResumeBlockedWorkerMonitor(
      { ...run, status: 'monitoring' },
      { attemptId: 'new', status: 'running' },
    ),
    false,
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
