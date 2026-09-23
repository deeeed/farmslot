import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  blockedWorkerOwnsSlot,
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
  steps: [{ name: 'monitor', status: 'done', outputs: { workerSignal: { attemptId: 'old' } } }],
  taskFile: '/repo/.sandbox/farmslot-farm/tasks/fix/manual-000110/TASK.md',
  agentContexts: [
    {
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

test('monitor replay requires a fresh non-blocked worker signal', () => {
  assert.equal(canResumeBlockedWorkerMonitor(run, { attemptId: 'old', status: 'running' }), false);
  assert.equal(canResumeBlockedWorkerMonitor(run, { attemptId: 'new', status: 'blocked' }), false);
  assert.equal(canResumeBlockedWorkerMonitor(run, { attemptId: 'new', status: 'running' }), true);
  assert.equal(canResumeBlockedWorkerMonitor(run, { attemptId: 'new', status: 'complete' }), true);
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
    true,
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
