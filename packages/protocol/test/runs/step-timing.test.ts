import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run, RunStep } from '../../src/contracts/runs.js';
import { runDispatchQueueWaitMs, runStepExecutionMs } from '../../src/runs/step-timing.js';

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
