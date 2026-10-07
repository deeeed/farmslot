import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { type Run, runStepExecutionMs, runStepQueuedMs } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun, updateRunStep } from '../runs/store.js';

import { createPrepareProgressEmitter } from './dispatch-lifecycle-steps.js';
import { awaitAsQueueTime } from './find-slot-step.js';
import { stepEntryTiming } from './orchestrator.js';
import { mirrorMonitorStepProgress } from './run-monitor.js';
import { createSubStepCollector } from './sub-step-collector.js';

const T0 = Date.parse('2026-10-07T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function devRun(t: TestContext): Run {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `QUEUE-TIME-${Date.now()}-${Math.random()}`,
    slotId: 'slot-1',
    runner: 'claude',
    branch: 'queue-time-test',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });
  return run;
}

function step(runId: string, name: string) {
  return getRun(runId)!.steps.find((candidate) => candidate.name === name)!;
}

test('a run that waited for a slot records that wait as find-slot queue time, not execution', async (t) => {
  const run = devRun(t);
  updateRunStep(run.id, 'find-slot', { status: 'running', startedAt: iso(T0) });
  let clock = T0 + 5_000;
  let resolveDecision!: (action: string) => void;
  const decision = new Promise<string>((resolve) => (resolveDecision = resolve));

  const waited = awaitAsQueueTime(
    run.id,
    'find-slot',
    () => decision,
    () => clock,
  );
  // While it waits, the open wait already shows as queue time, not execution.
  assert.equal(step(run.id, 'find-slot').queuedSince, iso(T0 + 5_000));
  assert.equal(runStepQueuedMs(step(run.id, 'find-slot'), T0 + 65_000), 60_000);
  assert.equal(runStepExecutionMs(getRun(run.id)!, step(run.id, 'find-slot'), T0 + 65_000), 5_000);

  clock = T0 + 125_000; // the operator picks a slot two minutes later
  resolveDecision('pick');
  assert.equal(await waited, 'pick');
  assert.equal(step(run.id, 'find-slot').queuedMs, 120_000);
  assert.equal(step(run.id, 'find-slot').queuedSince, undefined);

  // The step finishes 10s after the decision: 135s duration, 15s of it work.
  updateRunStep(run.id, 'find-slot', { status: 'done', durationMs: 135_000 });
  assert.equal(runStepExecutionMs(getRun(run.id)!, step(run.id, 'find-slot')), 15_000);
});

test('a decision an earlier attempt resolved replays without adding queue time', async (t) => {
  const run = devRun(t);
  updateRunStep(run.id, 'find-slot', { status: 'running', startedAt: iso(T0), queuedMs: 4_000 });
  await awaitAsQueueTime(
    run.id,
    'find-slot',
    async () => 'pick',
    () => T0,
  );
  assert.equal(step(run.id, 'find-slot').queuedMs, 4_000);
});

test('a waiter that outlives a re-entry adds nothing to the new attempt', async (t) => {
  const run = devRun(t);
  updateRunStep(run.id, 'find-slot', { status: 'running', startedAt: iso(T0) });
  let clock = T0;
  let resolveDecision!: (action: string) => void;
  const waited = awaitAsQueueTime(
    run.id,
    'find-slot',
    () => new Promise<string>((resolve) => (resolveDecision = resolve)),
    () => clock,
  );
  // The step is re-entered an hour later, then the old waiter resolves.
  clock = T0 + 3_600_000;
  updateRunStep(run.id, 'find-slot', {
    startedAt: iso(clock),
    ...stepEntryTiming(getRun(run.id)!, 'find-slot'),
  });
  clock += 10_000;
  resolveDecision('pick');
  await waited;
  assert.equal(step(run.id, 'find-slot').queuedMs, undefined);
  assert.equal(step(run.id, 'find-slot').queuedSince, undefined);
});

test('the dispatch-queue wait lands on find-slot and survives its re-entry; other steps reset', (t) => {
  const run = devRun(t);
  const createdAt = Date.parse(run.createdAt);
  updateRun(run.id, { queuedAt: iso(createdAt - 90_000) });
  const current = getRun(run.id)!;

  assert.deepEqual(stepEntryTiming(current, 'find-slot'), {
    queuedMs: 90_000,
    queuedSince: undefined,
    lastProgressAt: undefined,
  });

  // A restart re-enters find-slot after an in-step wait: startedAt and
  // durationMs restart, so the queue time drops back to the dispatch wait only.
  updateRunStep(run.id, 'find-slot', { queuedMs: 150_000 });
  updateRunStep(run.id, 'find-slot', stepEntryTiming(getRun(run.id)!, 'find-slot'));
  assert.equal(step(run.id, 'find-slot').queuedMs, 90_000);

  updateRunStep(run.id, 'prepare', {
    queuedMs: 30_000,
    queuedSince: iso(T0),
    lastProgressAt: iso(T0),
  });
  updateRunStep(run.id, 'prepare', stepEntryTiming(getRun(run.id)!, 'prepare'));
  assert.equal(step(run.id, 'prepare').queuedMs, undefined);
  assert.equal(step(run.id, 'prepare').queuedSince, undefined, 'an open wait does not carry over');
  assert.equal(step(run.id, 'prepare').lastProgressAt, undefined);
});

test('prepare stage lines are progress; stall notices and plain output are not', (t) => {
  const run = devRun(t);
  updateRunStep(run.id, 'prepare', { status: 'running', startedAt: iso(T0) });
  const emit = createPrepareProgressEmitter({
    runId: run.id,
    inputs: {},
    baseOutputs: { cliCommand: 'farmslot slot prepare slot-1' },
    collector: createSubStepCollector(),
    stepPartialIO: new Map(),
    broadcastFn: () => {},
  });

  emit('script.step', {
    name: 'preflight',
    detail: 'Running preflight (metro) — [3/5] launch --verify › [2/5] metro: bundling 61%, 1m42s',
  });
  assert.ok(step(run.id, 'prepare').lastProgressAt);

  // Pin an old progress time so any later bump is visible.
  const progressAt = iso(T0);
  updateRunStep(run.id, 'prepare', { lastProgressAt: progressAt });
  emit('script.output', { stream: 'stdout', data: 'webpack compiled 4210 modules\n' });
  assert.equal(step(run.id, 'prepare').lastProgressAt, progressAt);

  const stall =
    'Running preflight (metro) — [2/5] metro: no progress for 60s: still bundling, 2m42s';
  emit('script.step', { name: 'preflight', detail: stall });
  assert.equal(step(run.id, 'prepare').lastProgressAt, progressAt);
  assert.equal(step(run.id, 'prepare').detail, stall, 'the stall notice is still shown');

  emit('script.step', { name: 'preflight', detail: 'Running preflight (metro) — [3/5] app: open' });
  assert.notEqual(step(run.id, 'prepare').lastProgressAt, progressAt);
});

test('the monitor step mirrors structured worker progress', (t) => {
  const run = devRun(t);
  mirrorMonitorStepProgress(getRun(run.id)!, iso(T0));
  assert.equal(step(run.id, 'monitor').lastProgressAt, undefined, 'only a running monitor');

  updateRunStep(run.id, 'monitor', { status: 'running', startedAt: iso(T0) });
  mirrorMonitorStepProgress(getRun(run.id)!, iso(T0 - 60_000));
  assert.equal(
    step(run.id, 'monitor').lastProgressAt,
    undefined,
    'progress restored from before this attempt',
  );
  mirrorMonitorStepProgress(getRun(run.id)!, iso(T0 + 60_000));
  assert.equal(step(run.id, 'monitor').lastProgressAt, iso(T0 + 60_000));
});
