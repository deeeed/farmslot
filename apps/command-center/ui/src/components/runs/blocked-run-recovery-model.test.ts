import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  blockedWorkerProofPlanPath,
  blockedWorkerSignalPath,
  canResumeBlockedWorkerMonitor,
  parseBlockedWorkerProofPlan,
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

test('proof plan path stays inside the selected Farmslot worker task', () => {
  assert.equal(
    blockedWorkerProofPlanPath(run),
    '.sandbox/farmslot-farm/worker-task/fix/manual-000110/artifacts/proof-plan.json',
  );
  assert.equal(blockedWorkerProofPlanPath({ ...run, project: 'other' }), null);
  assert.equal(
    blockedWorkerSignalPath({
      ...run,
      agentContexts: [
        { runId: 'run-1', signalFile: '.sandbox/farmslot-farm/worker-task/../private/SIGNAL.json' },
      ],
    } as Run),
    null,
  );
});

test('proof plan rejects another run or slot before acquiring capabilities', () => {
  const content = JSON.stringify({
    version: 1,
    slotId: run.slotId,
    ownerRunId: run.id,
    requirements: [{ capabilityId: 'browser-cdp', reason: 'Browser proof', mode: 'visual' }],
  });
  assert.equal(
    parseBlockedWorkerProofPlan(content, run).requirements[0]?.capabilityId,
    'browser-cdp',
  );
  assert.throws(() => parseBlockedWorkerProofPlan(content, { ...run, id: 'other' }));
  assert.throws(() => parseBlockedWorkerProofPlan(content, { ...run, slotId: 'other' }));
});

test('monitor replay requires a fresh non-blocked worker signal', () => {
  assert.equal(canResumeBlockedWorkerMonitor(run, { attemptId: 'old', status: 'running' }), false);
  assert.equal(canResumeBlockedWorkerMonitor(run, { attemptId: 'new', status: 'blocked' }), false);
  assert.equal(canResumeBlockedWorkerMonitor(run, { attemptId: 'new', status: 'running' }), true);
  assert.equal(
    canResumeBlockedWorkerMonitor({ ...run, steps: [{ name: 'monitor', status: 'done' }] } as Run, {
      attemptId: 'new',
      status: 'running',
    }),
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
