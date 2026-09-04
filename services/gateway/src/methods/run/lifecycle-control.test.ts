import assert from 'node:assert/strict';
import test from 'node:test';

import { Events, type MachineParkRecord } from '@farmslot/protocol';

import { withMachineRunTransition } from '../../run-lifecycle/transition-coordinator.js';
import { createRun, deleteRun, getRun, updateRun, updateRunStep } from '../../runs/store.js';

import {
  publishForceCompletedRun,
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

test('runForceComplete requires a PR number when completing a blocked run', async (t) => {
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
    /force-complete requires a published PR number/,
  );

  updateRun(run.id, { status: 'ci-watching' });
  const result = await runForceComplete({ runId: run.id }, () => {});
  assert.equal(result.run.id, run.id);
  assert.equal(result.run.status, 'ci-watching');
});

test('runForceComplete marks a blocked run done when its PR is already published', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-blocked`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'blocked',
    error: 'review finding requires an external dependency',
    steps: [{ name: 'human-gate', status: 'running' }],
  });

  const result = await runForceComplete({ runId: run.id, prNumber: 35670 }, () => {});

  assert.equal(result.run.status, 'done');
  assert.equal(result.run.error, undefined);
  assert.equal(result.run.prNumber, 35670);
  assert.equal(result.run.steps[0]?.status, 'skipped');
  assert.match(result.run.steps[0]?.detail ?? '', /blocked run/);

  updateRun(run.id, { status: 'human-gating' });
  updateRunStep(run.id, 'human-gate', { status: 'running' });
  assert.equal(getRun(run.id)?.status, 'done');
  assert.equal(getRun(run.id)?.steps[0]?.status, 'skipped');
});

test('runForceComplete ignores a stored 0 PR sentinel outside the blocked path', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-ci-watch-zero-pr`,
  });
  t.after(() => cleanupRun(run.id));
  // `0` is the invalid-PR sentinel, not a linked PR. It must never be promoted
  // into a fallback that then fails positive-number validation.
  updateRun(run.id, { status: 'ci-watching', prNumber: 0 });

  const result = await runForceComplete({ runId: run.id }, () => {});

  assert.equal(result.run.status, 'ci-watching');
});

test('runForceComplete rejects a blocked run whose stored PR is the 0 sentinel', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-blocked-zero-pr`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, { status: 'blocked', prNumber: 0 });

  await assert.rejects(
    () => runForceComplete({ runId: run.id }, () => {}),
    /force-complete requires a published PR number/,
  );
});

test('runForceComplete uses the run own PR number when completing a blocked run', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-blocked-linked-pr`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'blocked',
    prNumber: 34865,
    error: 'review finding requires an external dependency',
    steps: [{ name: 'human-gate', status: 'running' }],
  });

  // No prNumber in the params: the run is already linked to a published PR, so
  // the caller must not have to resend the number it already owns.
  const result = await runForceComplete({ runId: run.id }, () => {});

  assert.equal(result.run.status, 'done');
  assert.equal(result.run.prNumber, 34865);
  assert.equal(result.run.steps[0]?.status, 'skipped');
});

test('runForceComplete repairs a stale active status after an earlier force completion', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-repair-force-complete`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'human-gating',
    prNumber: 35670,
    engineState: { operatorForceCompleted: true },
    steps: [{ name: 'human-gate', status: 'running' }],
  });

  const result = await runForceComplete({ runId: run.id, prNumber: 35670 }, () => {});

  assert.equal(result.run.status, 'done');
  assert.equal(result.run.steps[0]?.status, 'skipped');
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

test('runForceComplete supersedes unresolved operational decisions and keeps retrospectives', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-decisions`,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'failed',
    error: 'self-review exhausted',
    decisions: [
      {
        id: 'gate-1',
        type: 'engine_human_gate',
        title: 'Publication gate',
        description: 'Waiting',
        actions: [],
        createdAt: '2026-08-23T00:00:00.000Z',
        context: {},
      },
      {
        id: 'retro-1',
        type: 'retrospective',
        title: 'Retrospective',
        description: 'Grade later',
        actions: [],
        createdAt: '2026-08-23T00:00:00.000Z',
        context: {},
      },
    ],
  });

  const result = await runForceComplete({ runId: run.id }, () => {});
  const gate = result.run.decisions.find((decision) => decision.id === 'gate-1');
  const retro = result.run.decisions.find((decision) => decision.id === 'retro-1');
  assert.equal(gate?.resolvedAction, 'superseded');
  assert.ok(gate?.resolvedAt);
  assert.equal(gate?.context?.supersededBy, 'operator-force-complete');
  assert.equal(retro?.resolvedAt, undefined);
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
      releaseSlot: async () => ({ released: false }),
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
      releaseSlot: async () => ({ released: false }),
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
    releaseSlot: async () => ({ released: false }),
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

test('runForceComplete publishes terminal state before slot release and reports a failed release', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-slot`,
    slotId: 'force-complete-slot',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, { status: 'failed', error: 'self-review exhausted' });

  const order: string[] = [];
  const result = await runForceCompleteTransitionLocked({ runId: run.id }, () => {}, {
    cancelEngine: () => {},
    bumpGeneration: (runId) => {
      const current = getRun(runId)!;
      const generation = (current.engineState?.generation ?? 0) + 1;
      updateRun(runId, { engineState: { ...(current.engineState ?? {}), generation } });
      return generation;
    },
    attachPrNumber: async () => {},
    publish: async (published) => {
      order.push('publish');
      assert.equal(published.status, 'done');
      return published;
    },
    releaseSlot: async (released) => {
      order.push('release');
      assert.equal(released.slotId, 'force-complete-slot');
      assert.equal(released.id, run.id);
      throw new Error('ssh teardown failed');
    },
  });

  assert.deepEqual(order, ['publish', 'release']);
  assert.equal(result.run.status, 'done');
  assert.equal(
    result.effects?.some((effect) => effect.name === 'slot-release' && effect.status === 'failed'),
    true,
  );
  assert.match(
    result.effects?.find((effect) => effect.name === 'slot-release')?.detail ?? '',
    /ssh teardown failed/,
  );
});

test('publishForceCompletedRun broadcasts RUN_UPDATED then RUN_COMPLETED', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-force-completed-event`,
  });
  t.after(() => cleanupRun(run.id));
  const done = updateRun(run.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    metrics: { ...run.metrics, outcome: 'success' },
  });
  const events: string[] = [];
  await publishForceCompletedRun(done, (event) => {
    events.push(event);
  });
  assert.equal(events[0], Events.RUN_UPDATED);
  assert.equal(events[1], Events.RUN_COMPLETED);
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

test('resume rejects an operator-held interactive completion', async (t) => {
  const run = pausedMonitorRun(`PROJ-${Date.now()}-resume-operator-hold`);
  updateRun(run.id, {
    steps: getRun(run.id)!.steps.map((step) =>
      step.name === 'monitor'
        ? {
            ...step,
            outputs: {
              awaitingOperator: true,
              reason: 'interactive-completion-operator-owned',
            },
          }
        : step,
    ),
  });
  t.after(() => cleanupRun(run.id));

  await assert.rejects(
    () =>
      runResumeTransitionLocked(
        { runId: run.id },
        () => {},
        {},
        {
          nudgeMonitor: async () => {
            throw new Error('must not nudge an operator-held worker');
          },
          redrive: async () => {
            throw new Error('must not redrive an operator-held monitor');
          },
        },
      ),
    /waiting for an interactive completion action, not Resume/,
  );
  assert.equal(getRun(run.id)?.status, 'paused');
  assert.equal(getRun(run.id)?.engineState?.generation, 3);
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
