import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { Events, type RunDecision } from '@farmslot/protocol';

import { statusFile } from '../../core/state.js';
import { cancelRunEngine } from '../../run-engine/orchestrator.js';
import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { replaySlotReclaimCheck, runReplayStep } from './replay-step.js';

test('replaySlotReclaimCheck rejects slots owned by another active run', () => {
  assert.deepEqual(
    replaySlotReclaimCheck({ current_run_id: 'run-b', lifecycle: 'busy' }, 'run-a'),
    {
      ok: false,
      reason: 'owned-by-other',
      owner: 'run-b',
    },
  );
  assert.deepEqual(
    replaySlotReclaimCheck({ current_run_id: 'run-a', lifecycle: 'busy' }, 'run-a'),
    {
      ok: true,
    },
  );
  assert.deepEqual(replaySlotReclaimCheck({ current_run_id: null, lifecycle: 'ready' }, 'run-a'), {
    ok: true,
  });
  assert.deepEqual(replaySlotReclaimCheck({ current_run_id: null, lifecycle: 'busy' }, 'run-a'), {
    ok: false,
    reason: 'not-reclaimable',
    lifecycle: 'busy',
  });
});

test('replaySlotReclaimCheck allows reclaim when slot owner run record is missing', () => {
  assert.deepEqual(
    replaySlotReclaimCheck({ current_run_id: 'ghost-run', lifecycle: 'busy' }, 'run-a', {
      ownerRunExists: () => false,
    }),
    { ok: true },
  );
});

test('runReplayStep rejects read-only imported reference runs', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `REF-${Date.now()}`,
  });
  updateRun(run.id, { readOnly: true, status: 'done' });
  t.after(async () => {
    if (getRun(run.id)) {
      await deleteRun(run.id);
    }
  });
  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'prepare' }, () => {}),
    /read-only imported reference and cannot be replayed/,
  );
});

test('runReplayStep rejects monitor replay when dispatch is still running', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'dispatching',
    slotId: 'macwork-ff-1',
    steps: run.steps.map((step) =>
      step.name === 'write-task' || step.name === 'find-slot' || step.name === 'prepare'
        ? { ...step, status: 'done' }
        : step.name === 'dispatch'
          ? { ...step, status: 'running', startedAt: new Date().toISOString() }
          : step,
    ),
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {}),
    /dispatch has not completed/,
  );
});

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

test('runReplayStep still rejects PR-bound replays without a linked prNumber', async (t) => {
  const run = createRun({
    flowType: 'merge-main',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-3398',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
    /Cannot replay run:/,
  );
});

test('runReplayStep still rejects write-task replay for chained PR-bound runs with Jira ticketOrPr', async (t) => {
  const run = createRun({
    flowType: 'merge-main',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-3398',
    prNumber: 3398,
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () =>
      runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {}),
    /Cannot replay run:/,
  );
});

test('runReplayStep allows chained PR-bound replays when prNumber is already linked', async (t) => {
  const run = createRun({
    flowType: 'merge-main',
    project: 'farmslot-farm',
    ticketOrPr: 'PROJ-3398',
    prNumber: 3398,
  });
  const doneBeforeCiWatch = new Set([
    'write-task',
    'dispatch',
    'monitor',
    'self-review',
    'complete',
    'finalize',
  ]);
  updateRun(run.id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    error: 'Cancelled by user',
    steps: run.steps.map((step) =>
      step.name === 'ci-watch'
        ? { ...step, status: 'skipped', completedAt: new Date().toISOString() }
        : doneBeforeCiWatch.has(step.name)
          ? { ...step, status: 'done', completedAt: new Date().toISOString() }
          : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'cancelled', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.doesNotReject(() =>
    runReplayStep({ runId: run.id, stepName: 'ci-watch', triggeredBy: 'operator' }, () => {}),
  );
  assert.equal(getRun(run.id)?.status, 'ci-watching');
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

test('runReplayStep normalizes stale earlier steps when replaying from a later step', async (t) => {
  const taskFile = '/tmp/farmslot-stale-monitor-task/TASK.md';
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'blocked',
    error: 'monitor timed out',
    taskFile,
    steps: run.steps.map((step) =>
      step.name === 'find-slot' ||
      step.name === 'write-task' ||
      step.name === 'prepare' ||
      step.name === 'dispatch'
        ? { ...step, status: 'done', outputs: step.name === 'write-task' ? { taskFile } : {} }
        : step.name === 'monitor'
          ? { ...step, status: 'running', startedAt: '2026-06-22T12:00:00.000Z' }
          : step.name === 'self-review'
            ? { ...step, status: 'failed', detail: 'retry requested' }
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
    { runId: run.id, stepName: 'self-review', triggeredBy: 'operator' },
    (event, payload) => {
      if (event === Events.RUN_UPDATED) {
        emittedStatuses.push((payload as { run: { status: string } }).run.status);
      }
    },
  );

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.steps.find((step) => step.name === 'monitor')?.status, 'done');
  assert.equal(
    replayed.steps.find((step) => step.name === 'monitor')?.outputs?.replayPrerequisiteNormalized,
    true,
  );
  assert.equal(replayed.steps.find((step) => step.name === 'self-review')?.status, 'running');
  assert.equal(emittedStatuses[0], 'self-reviewing');
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

test('runReplayStep restores skipPrepare for chained follow-ups when the flag was already cleared', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'prepare failed',
    engineState: { flags: { warmRecovery: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot'
        ? { ...step, status: 'done' }
        : step.name === 'write-task' || step.name === 'prepare'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.engineState?.flags?.skipPrepare, true);
  assert.equal(replayed.engineState?.flags?.warmRecovery, true);
});

test('runReplayStep clears skipPrepare when chained follow-up replays from find-slot', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'find-slot failed',
    engineState: { flags: { skipPrepare: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot' ? { ...step, status: 'failed' } : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'find-slot', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.slotId, null);
  assert.equal(replayed.engineState?.flags?.skipPrepare, undefined);
});

test('runReplayStep preserves skipPrepare for review-pr chained follow-up replays', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'review-pr',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'write-task failed',
    engineState: { flags: { skipPrepare: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot'
        ? { ...step, status: 'done' }
        : step.name === 'write-task'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.engineState?.flags?.skipPrepare, true);
});

test('runReplayStep preserves skipPrepare for CI-watch chained follow-up replays', async (t) => {
  const parent = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  const run = createRun({
    flowType: 'pr-complete',
    project: 'farmslot-farm',
    ticketOrPr: 'example-org/example-browser#123456',
    familyId: parent.id,
    parentRunId: parent.id,
    familyRootTicketOrPr: parent.ticketOrPr,
    slotId: 'runner-browser-1',
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'write-task failed',
    engineState: { flags: { skipPrepare: true } },
    steps: run.steps.map((step) =>
      step.name === 'find-slot'
        ? { ...step, status: 'done' }
        : step.name === 'write-task'
          ? { ...step, status: 'failed' }
          : step,
    ),
  });

  t.after(async () => {
    for (const id of [run.id, parent.id]) {
      if (getRun(id)) {
        updateRun(id, { status: 'failed', completedAt: new Date().toISOString() });
        await deleteRun(id);
      }
    }
  });

  await runReplayStep({ runId: run.id, stepName: 'write-task', triggeredBy: 'operator' }, () => {});

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.engineState?.flags?.skipPrepare, true);
  assert.equal(replayed.engineState?.flags?.nudgeReuse, undefined);
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

test('runReplayStep rejects monitor replay when dispatch is still pending', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'preparing',
    slotId: 'macwork-ff-4',
    taskFile: '/tmp/TASK.md',
    steps: run.steps.map((step) => {
      if (step.name === 'find-slot' || step.name === 'write-task' || step.name === 'prepare') {
        return { ...step, status: 'done' as const };
      }
      return step;
    }),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await assert.rejects(
    () => runReplayStep({ runId: run.id, stepName: 'monitor', triggeredBy: 'operator' }, () => {}),
    /dispatch has not completed/,
  );
  assert.equal(getRun(run.id)?.slotId, 'macwork-ff-4');
});

test('runReplayStep recovers slotId from find-slot outputs on dispatch replay', async (t) => {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  await writeFile(
    statusFile,
    JSON.stringify(
      { slots: [{ slot: 'macwork-ff-4', lifecycle: 'ready', current_run_id: null }] },
      null,
      2,
    ) + '\n',
  );

  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    status: 'failed',
    error: 'No slot assigned',
    slotId: null,
    taskFile: '/tmp/TASK.md',
    steps: run.steps.map((step) => {
      if (step.name === 'find-slot') {
        return {
          ...step,
          status: 'done' as const,
          outputs: { selectedSlot: 'macwork-ff-4', runner: 'grok', model: 'grok-build' },
        };
      }
      if (step.name === 'write-task' || step.name === 'prepare') {
        return { ...step, status: 'done' as const };
      }
      if (step.name === 'dispatch') {
        return { ...step, status: 'failed' as const, detail: 'No slot assigned' };
      }
      return step;
    }),
  });

  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  await runReplayStep(
    { runId: run.id, stepName: 'dispatch', skipPrepare: true, triggeredBy: 'operator' },
    () => {},
  );

  const replayed = getRun(run.id);
  assert.ok(replayed);
  assert.equal(replayed.slotId, 'macwork-ff-4');
  assert.notEqual(replayed.steps.find((step) => step.name === 'dispatch')?.status, 'failed');
  cancelRunEngine(run.id);
});
