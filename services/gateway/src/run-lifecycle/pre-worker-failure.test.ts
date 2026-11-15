import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRun } from '../run-engine/test-fixtures.js';

import {
  BEFORE_WORKER_LAUNCH,
  failedBeforeWorkerLaunch,
  WORKER_LAUNCH,
  workerMayHaveStarted,
} from './pre-worker-failure.js';

test('only known pre-launch failures relinquish the prepared checkout', () => {
  for (const name of ['find-slot', 'write-task', 'prepare', 'dispatch']) {
    const run = makeRun({
      status: 'failed',
      steps: [{ name, status: 'failed', outputs: { failedPhase: BEFORE_WORKER_LAUNCH } }],
    });
    assert.equal(failedBeforeWorkerLaunch(run), true, name);
    run.agentContexts = [
      {
        id: 'dev',
        role: 'dev',
        label: 'Dev',
        status: 'failed',
        slotId: run.slotId,
        runId: run.id,
        startedAt: run.createdAt,
      },
    ];
    assert.equal(workerMayHaveStarted(run), true);
    if (name === 'dispatch') run.steps[0]!.outputs = { failedPhase: WORKER_LAUNCH };
    assert.equal(failedBeforeWorkerLaunch(run), false, 'a prior worker keeps replay retention');
  }
  for (const failedPhase of [undefined, WORKER_LAUNCH]) {
    const run = makeRun({
      status: 'failed',
      steps: [{ name: 'dispatch', status: 'failed', outputs: { failedPhase } }],
    });
    assert.equal(failedBeforeWorkerLaunch(run), false, 'unknown or attempted launch is retained');
  }
});

test('creating the current launching context is not a worker launch', () => {
  const run = makeRun({
    status: 'failed',
    steps: [
      {
        name: 'dispatch',
        status: 'failed',
        startedAt: '2026-11-15T07:00:00Z',
        outputs: { failedPhase: BEFORE_WORKER_LAUNCH },
      },
    ],
  });
  run.agentContexts = [
    {
      id: 'dev',
      role: 'dev',
      label: 'Dev',
      slotId: run.slotId,
      runId: run.id,
      status: 'failed',
      startedAt: '2026-11-15T07:00:01Z',
    },
  ];
  assert.equal(failedBeforeWorkerLaunch(run), true);
  run.steps[0]!.outputs = { failedPhase: WORKER_LAUNCH };
  assert.equal(
    failedBeforeWorkerLaunch(run),
    false,
    'uncertain prompt delivery retains the checkout',
  );
});
