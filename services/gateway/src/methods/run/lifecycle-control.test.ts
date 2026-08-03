import assert from 'node:assert/strict';
import test from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { runCancel, runForceComplete, runPause } from './lifecycle-control.js';

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

test('runCancel marks non-terminal runs cancelled without slot release side effects', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-cancel`,
  });
  updateRun(run.id, {
    steps: [
      { name: 'find-slot', status: 'done' },
      { name: 'human-gate', status: 'running' },
      { name: 'complete', status: 'pending' },
    ],
  });
  t.after(() => cleanupRun(run.id));

  const result = await runCancel({ runId: run.id, reason: 'operator cleanup' });

  assert.equal(result.run.status, 'cancelled');
  assert.equal(result.run.error, 'operator cleanup');
  assert.equal(result.run.metrics.outcome, 'cancelled');
  assert.equal(
    result.run.backlogReconcilePending,
    undefined,
    'a successful backlog settle clears the write-ahead repair marker',
  );
  assert.deepEqual(
    result.run.steps.map((step) => [step.name, step.status]),
    [
      ['find-slot', 'done'],
      ['human-gate', 'skipped'],
      ['complete', 'skipped'],
    ],
  );
});

test('runCancel rejects terminal runs', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-cancel-terminal`,
  });
  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  t.after(() => cleanupRun(run.id));

  await assert.rejects(() => runCancel({ runId: run.id }), /already in terminal state/);
});

test('runPause pauses monitoring runs and rejects non-pausable statuses', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-pause`,
  });
  updateRun(run.id, { status: 'monitoring' });
  t.after(() => cleanupRun(run.id));

  const result = await runPause({ runId: run.id }, () => {});
  assert.equal(result.run.status, 'paused');

  await assert.rejects(() => runPause({ runId: run.id }, () => {}), /cannot be paused/);
});

test('runForceComplete only accepts ci-watching runs', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force`,
  });
  t.after(() => cleanupRun(run.id));

  await assert.rejects(
    () => runForceComplete({ runId: run.id }, () => {}),
    /cannot be force-completed/,
  );

  updateRun(run.id, { status: 'ci-watching' });
  const result = await runForceComplete({ runId: run.id }, () => {});
  assert.equal(result.run.id, run.id);
  assert.equal(result.run.status, 'ci-watching');
});
