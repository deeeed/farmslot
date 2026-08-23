import assert from 'node:assert/strict';
import test from 'node:test';

import type { MachineParkRecord } from '@farmslot/protocol';

import { withMachineRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import {
  runCancel,
  runForceComplete,
  runForceCompleteTransitionLocked,
  runPause,
  runResume,
  runResumeTransitionLocked,
} from './lifecycle-control.js';

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, {
    status: 'done',
    completedAt: new Date().toISOString(),
    backlogReconcilePending: undefined,
  });
  await deleteRun(runId);
}

function parkedRecord(runId: string, slotId: string): MachineParkRecord {
  return {
    version: 1,
    operationId: `park-${runId}`,
    previewId: `preview-${runId}`,
    runId,
    generation: 0,
    machine: 'machine-a',
    slotId,
    mode: 'orchestration',
    phase: 'parked',
    prePauseStatus: 'monitoring',
    prePauseCurrentStep: { index: 0, name: 'monitor', status: 'running' },
    resourceManifest: { capturedAt: new Date().toISOString(), resources: [], capabilityLeases: [] },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'running', resources: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
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

test('runCancel clears a parked record after terminal cleanup succeeds', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-cancel-parked`,
  });
  updateRun(run.id, { status: 'paused', park: parkedRecord(run.id, 'detached-slot') });
  t.after(() => cleanupRun(run.id));

  const result = await runCancel({ runId: run.id });
  assert.equal(result.run.status, 'cancelled');
  assert.equal(result.run.park, null);
});

test('runCancel retains parked residual evidence when terminal cleanup fails', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-cancel-parked-partial`,
    slotId: 'missing-machine-park-slot',
  });
  updateRun(run.id, {
    status: 'paused',
    park: parkedRecord(run.id, 'missing-machine-park-slot'),
  });
  t.after(() => cleanupRun(run.id));

  const result = await runCancel({ runId: run.id });
  assert.equal(result.run.status, 'cancelled');
  assert.equal(
    result.effects?.some((effect) => effect.status === 'failed'),
    true,
  );
  assert.equal(result.run.park?.phase, 'cancelled');
  assert.equal(
    result.run.park?.errors.some((error) => error.code === 'TERMINAL_CLEANUP_FAILED'),
    true,
  );
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

test('runForceComplete only accepts ci-watching or failed runs', async (t) => {
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

  updateRun(run.id, { status: 'blocked' });
  await assert.rejects(
    () => runForceComplete({ runId: run.id }, () => {}),
    /cannot be force-completed in status: blocked/,
  );

  updateRun(run.id, { status: 'ci-watching' });
  const result = await runForceComplete({ runId: run.id }, () => {});
  assert.equal(result.run.id, run.id);
  assert.equal(result.run.status, 'ci-watching');
});

test('runForceComplete marks a failed run done and can persist a PR number', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-failed`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'failed',
    error: 'self-review exhausted',
    engineState: { generation: 2 },
    steps: [
      { name: 'self-review', status: 'failed' },
      { name: 'complete', status: 'skipped' },
      { name: 'human-gate', status: 'skipped' },
    ],
  });

  const result = await runForceComplete({ runId: run.id, prNumber: 35145 }, () => {});
  assert.equal(result.run.status, 'done');
  assert.equal(result.run.error, undefined);
  assert.equal(result.run.prNumber, 35145);
  assert.equal(result.run.metrics.outcome, 'success');
  assert.ok(result.run.completedAt);
  assert.equal(result.run.engineState?.generation, 3);
  assert.equal(result.run.engineState?.operatorForceCompleted, true);
  assert.equal(result.run.recoveryProposal?.status, 'idle');
  assert.equal(result.run.backlogReconcilePending, undefined);
  const selfReview = result.run.steps.find((step) => step.name === 'self-review');
  assert.equal(selfReview?.status, 'skipped');
  assert.equal(selfReview?.outputs?.source, 'operator');
});

test('runForceComplete persists a PR on ci-watching without flipping status', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-ci-pr`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, { status: 'ci-watching' });

  const result = await runForceComplete({ runId: run.id, prNumber: 35145 }, () => {});
  assert.equal(result.run.status, 'ci-watching');
  assert.equal(result.run.prNumber, 35145);
});

test('runForceComplete fences a failed run before attaching the PR', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-attach-order`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'failed',
    error: 'self-review exhausted',
    engineState: { generation: 2 },
    steps: [{ name: 'self-review', status: 'failed' }],
  });

  let cancelled = false;
  let attachSawDone = false;
  const result = await runForceCompleteTransitionLocked(
    { runId: run.id, prNumber: 35145 },
    () => {},
    {
      cancelEngine: () => {
        cancelled = true;
      },
      bumpGeneration: (runId) => {
        const current = getRun(runId)!;
        const generation = (current.engineState?.generation ?? 0) + 1;
        updateRun(runId, { engineState: { ...(current.engineState ?? {}), generation } });
        return generation;
      },
      attachPrNumber: async (runId) => {
        attachSawDone = getRun(runId)?.status === 'done' && cancelled;
        throw new Error('refresh failed');
      },
      publish: async (published) => published,
    },
  );
  assert.equal(cancelled, true);
  assert.equal(attachSawDone, true);
  assert.equal(result.run.status, 'done');
  assert.equal(result.run.prNumber, 35145);
  assert.equal(result.run.engineState?.generation, 3);
});

test('runForceComplete still aborts ci-watching when PR attach throws', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-ci-attach`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, { status: 'ci-watching' });

  let cancelled = false;
  const result = await runForceCompleteTransitionLocked(
    { runId: run.id, prNumber: 35145 },
    () => {},
    {
      cancelEngine: () => {
        cancelled = true;
      },
      bumpGeneration: () => 1,
      attachPrNumber: async () => {
        throw new Error('refresh failed');
      },
      publish: async (published) => published,
    },
  );
  assert.equal(cancelled, true);
  assert.equal(result.run.status, 'ci-watching');
});

test('runForceComplete still returns done when publication after-effects throw', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-publish`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, { status: 'failed', error: 'self-review exhausted' });

  const result = await runForceCompleteTransitionLocked({ runId: run.id }, () => {}, {
    cancelEngine: () => {},
    bumpGeneration: () => 1,
    attachPrNumber: async () => {},
    publish: async () => {
      throw new Error('settle failed');
    },
  });
  assert.equal(result.run.status, 'done');
  assert.equal(result.run.metrics.outcome, 'success');
  assert.equal(result.run.backlogReconcilePending, true);
});

test('runForceComplete rejects a non-positive prNumber', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-pr`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, { status: 'failed' });

  await assert.rejects(
    () => runForceComplete({ runId: run.id, prNumber: 0 }, () => {}),
    /prNumber must be a positive integer/,
  );
  await assert.rejects(
    () => runForceComplete({ runId: run.id, prNumber: 1.5 }, () => {}),
    /prNumber must be a positive integer/,
  );
  assert.equal(getRun(run.id)?.status, 'failed');
});

function pausedMonitorRun(ticket: string) {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: ticket,
  });
  updateRun(run.id, {
    status: 'paused',
    steps: [
      { name: 'find-slot', status: 'done' },
      { name: 'monitor', status: 'running' },
      { name: 'complete', status: 'pending' },
    ],
    engineState: { generation: 3 },
  });
  return run;
}

test('locked resume awaits matching generation and step acknowledgement', async (t) => {
  const run = pausedMonitorRun(`PROJ-${Date.now()}-resume-ack`);
  t.after(() => cleanupRun(run.id));
  let nudges = 0;
  const result = await runResumeTransitionLocked(
    { runId: run.id },
    () => {},
    {},
    {
      nudgeMonitor: async () => {
        nudges += 1;
      },
      redrive: async (runId, generation) => ({
        runId,
        generation,
        stepName: 'monitor',
        status: 'monitoring',
        acknowledgedAt: '2026-08-21T00:00:00.000Z',
      }),
    },
  );

  assert.equal(nudges, 1);
  assert.equal(result.previousGeneration, 3);
  assert.equal(result.generation, 4);
  assert.equal(result.run.status, 'monitoring');
  assert.equal(result.run.engineState?.generation, 4);
});

test('release restore suppresses the ordinary monitor resume nudge', async (t) => {
  const run = pausedMonitorRun(`PROJ-${Date.now()}-resume-no-nudge`);
  t.after(() => cleanupRun(run.id));
  let nudges = 0;
  await runResumeTransitionLocked(
    { runId: run.id },
    () => {},
    { suppressMonitorNudge: true, machineParkingRestore: true },
    {
      nudgeMonitor: async () => {
        nudges += 1;
      },
      redrive: async (runId, generation) => ({
        runId,
        generation,
        stepName: 'monitor',
        status: 'monitoring',
        acknowledgedAt: '2026-08-21T00:00:00.000Z',
      }),
    },
  );
  assert.equal(nudges, 0);
});

test('resume failure re-parks the run while preserving monotonic generation fencing', async (t) => {
  const run = pausedMonitorRun(`PROJ-${Date.now()}-resume-failure`);
  t.after(() => cleanupRun(run.id));
  await assert.rejects(
    () =>
      runResumeTransitionLocked(
        { runId: run.id },
        () => {},
        { suppressMonitorNudge: true, machineParkingRestore: true },
        {
          nudgeMonitor: async () => {},
          redrive: async () => {
            throw new Error('engine restart failed');
          },
        },
      ),
    /engine restart failed/,
  );
  assert.equal(getRun(run.id)?.status, 'paused');
  assert.equal(getRun(run.id)?.engineState?.generation, 4);
});

test('public resume rejects runs owned by an active machine park record', async (t) => {
  const run = pausedMonitorRun(`PROJ-${Date.now()}-resume-machine-owned`);
  updateRun(run.id, { park: parkedRecord(run.id, 'detached-slot') });
  t.after(() => cleanupRun(run.id));
  await assert.rejects(
    () => runResume({ runId: run.id }, () => {}),
    /managed by machine pause phase 'parked'/,
  );
  assert.equal(getRun(run.id)?.status, 'paused');
  assert.equal(getRun(run.id)?.engineState?.generation, 3);
});

test('public pause and force-complete reject active machine park ownership', async (t) => {
  const pauseRun = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-pause-machine-owned`,
  });
  const forceRun = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-machine-owned`,
  });
  updateRun(pauseRun.id, {
    status: 'monitoring',
    park: parkedRecord(pauseRun.id, 'pause-slot'),
  });
  updateRun(forceRun.id, {
    status: 'ci-watching',
    park: parkedRecord(forceRun.id, 'force-slot'),
  });
  t.after(() => Promise.all([cleanupRun(pauseRun.id), cleanupRun(forceRun.id)]));

  await assert.rejects(
    () => runPause({ runId: pauseRun.id }, () => {}),
    /managed by machine pause/,
  );
  await assert.rejects(
    () => runForceComplete({ runId: forceRun.id }, () => {}),
    /managed by machine pause/,
  );
  assert.equal(getRun(pauseRun.id)?.status, 'monitoring');
  assert.equal(getRun(forceRun.id)?.status, 'ci-watching');
});

test('public resume waits for the owning machine transition before rejecting fresh park state', async (t) => {
  const run = pausedMonitorRun(`PROJ-${Date.now()}-resume-machine-race`);
  updateRun(run.id, { park: parkedRecord(run.id, 'race-slot') });
  t.after(() => cleanupRun(run.id));
  let releaseMachine!: () => void;
  let machineEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    machineEntered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseMachine = resolve;
  });
  const machine = withMachineRunTransition('machine-a', async () => {
    machineEntered();
    await release;
  });
  await entered;

  let settled = false;
  const resume = runResume({ runId: run.id }, () => {}).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseMachine();
  await machine;
  const error = await resume;
  assert.match((error as Error).message, /managed by machine pause/);
  assert.equal(getRun(run.id)?.status, 'paused');
});
