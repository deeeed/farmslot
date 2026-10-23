import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run, RunStep } from '../../src/contracts/runs.js';
import {
  runDispatchQueueWaitMs,
  runElapsedTimeView,
  runStepExecutionMs,
  runStepQueuedMs,
} from '../../src/runs/step-timing.js';

test('run metadata shares total and current-step wall time and freezes terminal runs', () => {
  const source = {
    status: 'reviewing',
    createdAt: '2026-10-23T00:00:00Z',
    startedAt: '2026-10-23T00:10:00Z',
    updatedAt: '2026-10-23T02:24:00Z',
    steps: [{ name: 'review', status: 'running', startedAt: '2026-10-23T02:06:00Z' }],
  } satisfies Pick<Run, 'status' | 'createdAt' | 'startedAt' | 'updatedAt' | 'steps'>;
  const now = Date.parse('2026-10-23T02:24:00Z');
  assert.deepEqual(runElapsedTimeView(source, now), {
    live: true,
    label: '2h 14m total · review 18m',
  });
  assert.equal(runElapsedTimeView(source, now + 60000).label, '2h 15m total · review 19m');
  const completed = {
    ...source,
    status: 'done',
    completedAt: source.updatedAt,
  } satisfies RunTiming;
  assert.deepEqual(runElapsedTimeView(completed, now + 3600000), {
    live: false,
    label: '2h 14m total',
  });
  const legacy = {
    ...source,
    status: 'failed',
    statusChangedAt: source.updatedAt,
  } satisfies RunTiming;
  assert.equal(runElapsedTimeView(legacy, now + 3600000).label, '2h 14m total');
  assert.equal(
    runElapsedTimeView({ ...source, startedAt: undefined, steps: [] }, now).label,
    '2h 24m total',
  );
});

type RunTiming = Parameters<typeof runElapsedTimeView>[0];

function runWith(steps: RunStep[], queuedAt?: string) {
  return { createdAt: '2026-10-07T10:02:00.000Z', queuedAt, steps } satisfies Pick<
    Run,
    'createdAt' | 'queuedAt' | 'steps'
  >;
}

test('the dispatch-queue wait runs from queueing to run creation', () => {
  assert.equal(runDispatchQueueWaitMs(runWith([], '2026-10-07T10:00:00.000Z')), 120_000);
  assert.equal(runDispatchQueueWaitMs(runWith([])), undefined);
});

test('execution takes the waits inside a step out of its duration', () => {
  const prepare: RunStep = {
    name: 'prepare',
    status: 'done',
    durationMs: 300_000,
    queuedMs: 60_000,
  };
  const run = runWith([{ name: 'find-slot', status: 'done' }, prepare]);
  assert.equal(runStepExecutionMs(run, prepare), 240_000);
});

test('the first step keeps its pre-start dispatch-queue wait out of the subtraction', () => {
  // 2m queued before the run existed, then 30s waiting for a slot inside a 35s find-slot.
  const findSlot: RunStep = {
    name: 'find-slot',
    status: 'done',
    durationMs: 35_000,
    queuedMs: 150_000,
  };
  const run = runWith([findSlot], '2026-10-07T10:00:00.000Z');
  assert.equal(runStepExecutionMs(run, findSlot), 5_000);
});

test('a running step uses its elapsed time; a step that never ran has none', () => {
  const step: RunStep = {
    name: 'prepare',
    status: 'running',
    startedAt: '2026-10-07T10:00:00.000Z',
    queuedMs: 10_000,
  };
  const run = runWith([{ name: 'find-slot', status: 'done' }, step]);
  assert.equal(runStepExecutionMs(run, step, Date.parse('2026-10-07T10:01:00.000Z')), 50_000);
  assert.equal(runStepExecutionMs(run, { name: 'monitor', status: 'pending' }), undefined);
});

test('a wait that is still open counts as queue time, not execution', () => {
  const step: RunStep = {
    name: 'prepare',
    status: 'running',
    startedAt: '2026-10-07T10:05:00.000Z',
    queuedMs: 10_000,
    queuedSince: '2026-10-07T10:06:00.000Z',
  };
  const nowMs = Date.parse('2026-10-07T10:08:00.000Z');
  assert.equal(runStepQueuedMs(step, nowMs), 130_000);
  assert.equal(
    runStepExecutionMs(runWith([{ name: 'find-slot', status: 'done' }, step]), step, nowMs),
    50_000,
  );
  assert.equal(runStepQueuedMs({ name: 'x', status: 'done' }), 0);
  // Cancelled while waiting: the step is skipped and its open wait stops counting.
  assert.equal(runStepQueuedMs({ ...step, status: 'skipped' }, nowMs), 10_000);
});
