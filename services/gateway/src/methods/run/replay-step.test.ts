import assert from 'node:assert/strict';
import test from 'node:test';

import { Events, type RunDecision } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { runReplayStep } from './replay-step.js';

test('runReplayStep rejects non-authorized triggeredBy actor before replay', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'prepare', triggeredBy: 'llm' as any }, () => {}),
    /Invalid runReplayStep triggeredBy/,
  );
});

test('runReplayStep does not open a recovery attempt before replay validation passes', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Math.floor(Date.now() / 1000)}`,
  });
  const badTicketRun = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `not-a-ticket-${Date.now()}`,
  });
  const events: any[] = [];
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
    if (getRun(badTicketRun.id)) {
      updateRun(badTicketRun.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(badTicketRun.id);
    }
  });

  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'not-a-step' }, (event, payload) =>
        events.push({ event, payload }),
      ),
    /Step not found: not-a-step/,
  );

  assert.equal(events.length, 0);
  assert.equal(getRun(run.id)?.recoveryProposal?.status, undefined);
  assert.equal(getRun(run.id)?.recoveryAttempts?.length ?? 0, 0);

  await assert.rejects(
    () =>
      runReplayStep({ runId: badTicketRun.id, stepName: 'prepare' }, (event, payload) =>
        events.push({ event, payload }),
      ),
    /Cannot replay run:/,
  );
  assert.equal(events.length, 0);
  assert.equal(getRun(badTicketRun.id)?.recoveryProposal?.status, undefined);
  assert.equal(getRun(badTicketRun.id)?.recoveryAttempts?.length ?? 0, 0);
});

test('runReplayStep restores taskFile from completed write-task output for downstream replays', async (t) => {
  const taskFile = '/tmp/farmslot-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'No task file specified',
    taskFile: null,
    steps: run.steps.map((step) =>
      step.name === 'write-task'
        ? { ...step, status: 'done', outputs: { taskFile } }
        : step.name === 'prepare'
          ? { ...step, status: 'done' }
          : step.name === 'dispatch'
            ? { ...step, status: 'failed' }
            : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'dispatch', triggeredBy: 'operator' }, () => {});

  assert.equal(getRun(run.id)?.taskFile, taskFile);
});

test('runReplayStep moves terminal runs back to the active replay phase immediately', async (t) => {
  const taskFile = '/tmp/farmslot-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'dispatch failed',
    taskFile,
    steps: run.steps.map((step) =>
      step.name === 'write-task' || step.name === 'prepare'
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'dispatch'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });
  const emittedStatuses: string[] = [];

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep(
    { runId: run.id, stepName: 'dispatch', triggeredBy: 'operator' },
    (event, payload) => {
      if (event === Events.RUN_UPDATED) {
        emittedStatuses.push((payload as { run: { status: string } }).run.status);
      }
    },
  );

  assert.equal(emittedStatuses[0], 'dispatching');
});

test('runReplayStep clears stale decisions when replaying task generation', async (t) => {
  const taskFile = '/tmp/farmslot-stale-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const staleDecision: RunDecision = {
    id: 'stale-recipe-strategy',
    type: 'engine_recipe_strategy',
    title: 'Stale recipe strategy',
    description: 'Old decision from a prior task generation',
    actions: [{ id: 'accept', label: 'Use recommended', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    payload: { kind: 'recipe-strategy' } as any,
  };
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    decisions: [staleDecision],
    steps: run.steps.map((step) =>
      step.name === 'write-task' ? { ...step, status: 'failed', outputs: { taskFile } } : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.taskFile, null);
  assert.deepEqual(replayed.decisions, []);
});

test('runReplayStep forces eval worker replays through prepare to reinstall harness', async (t) => {
  const taskFile = '/tmp/farmslot-eval-task/TASK.md';
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'blocked',
    taskFile,
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-replay-harness',
        experimentKey: 'experiment-key-replay-harness',
        experimentManifestPath: '/tmp/experiment-manifest.json',
        packagePath: '/tmp/candidate.result-package.json',
        candidateStrategyFingerprint: 'fingerprint-replay-harness',
        trialId: 'trial-replay-harness',
      },
    },
    steps: run.steps.map((step) =>
      step.name === 'write-task'
        ? { ...step, status: 'done', outputs: { taskFile } }
        : step.name === 'prepare' || step.name === 'dispatch'
          ? { ...step, status: 'done' }
          : step.name === 'monitor'
            ? { ...step, status: 'failed' }
            : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.taskFile, taskFile);
  assert.equal(replayed.steps.find((step) => step.name === 'write-task')?.status, 'done');
  assert.equal(replayed.steps.find((step) => step.name === 'prepare')?.status, 'pending');
  assert.equal(replayed.steps.find((step) => step.name === 'dispatch')?.status, 'pending');
  assert.equal(replayed.steps.find((step) => step.name === 'monitor')?.status, 'pending');
  assert.equal(replayed.recoveryAttempts?.at(-1)?.stepName, 'prepare');
});

test('runReplayStep preserves resolved publish approvals for post-gate publish retries', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const approvedDecision: RunDecision = {
    id: 'publish-gate',
    type: 'engine_human_gate',
    title: 'Approve publication',
    description: 'Approve publication',
    actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    resolvedAt: '2026-04-15T00:01:00.000Z',
    resolvedAction: 'approve-publish',
    payload: { kind: 'ready' } as any,
  };
  const pendingDecision: RunDecision = {
    ...approvedDecision,
    id: 'pending-followup',
    resolvedAt: undefined,
    resolvedAction: undefined,
  };
  updateRun(run.id, {
    status: 'failed',
    error: 'publish failed',
    decisions: [approvedDecision, pendingDecision],
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'finalize', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.deepEqual(
    replayed.decisions.map((decision) => decision.id),
    ['publish-gate', 'pending-followup'],
    'finalize replay should keep the resolved publish approval as well as unresolved decisions',
  );
});

test('runReplayStep keeps unresolved decisions for no-human-gate finalize retries', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
  });
  const resolvedDecision: RunDecision = {
    id: 'old-decision',
    type: 'engine_human_gate',
    title: 'Old decision',
    description: 'Old decision',
    actions: [{ id: 'ok', label: 'OK', style: 'primary' as const }],
    createdAt: '2026-04-15T00:00:00.000Z',
    resolvedAt: '2026-04-15T00:01:00.000Z',
    resolvedAction: 'ok',
    payload: { kind: 'test' } as any,
  };
  const pendingDecision: RunDecision = {
    ...resolvedDecision,
    id: 'pending-decision',
    resolvedAt: undefined,
    resolvedAction: undefined,
  };
  updateRun(run.id, {
    status: 'failed',
    error: 'publish failed',
    decisions: [resolvedDecision, pendingDecision],
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'finalize', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.deepEqual(
    replayed.decisions.map((decision) => decision.id),
    ['pending-decision'],
    'no-human-gate finalize replay should not clear unresolved decisions by pretending there is a gate boundary',
  );
});
