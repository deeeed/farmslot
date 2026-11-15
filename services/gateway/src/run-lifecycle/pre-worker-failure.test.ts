import assert from 'node:assert/strict';
import test from 'node:test';

import { makeRun } from '../run-engine/test-fixtures.js';

import {
  BEFORE_WORKER_LAUNCH,
  failedBeforeWorkerLaunch,
  WORKER_LAUNCH,
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
