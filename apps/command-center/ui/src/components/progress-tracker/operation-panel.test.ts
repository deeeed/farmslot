import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskOperation, TaskProgressStructured } from '@farmslot/protocol';

import { litText } from '../../testing/lit-text.js';

import { renderOperationPanel, selectOperations } from './operation-panel.js';

const now = Date.parse('2026-09-29T01:00:40Z');
const operation: TaskOperation = {
  schemaVersion: 1,
  id: 'example',
  command: 'build',
  target: '/checkout',
  pid: 1,
  processStartedAt: 'identity',
  startedAt: '2026-09-29T01:00:00Z',
  updatedAt: '2026-09-29T01:00:00Z',
  status: 'running',
  logPath: 'artifacts/operations/example.log',
};
function progress(
  operations: TaskOperation | TaskOperation[],
  stepStatus?: 'running' | 'done',
): TaskProgressStructured {
  return {
    schema: { flowType: 'qa', title: 'Proof', totalSteps: 1, phases: [] },
    phases: stepStatus
      ? [
          {
            name: 'Reproduce',
            steps: [{ index: 7, name: 'Reproduce', status: stepStatus }],
            completedSteps: stepStatus === 'done' ? 1 : 0,
            totalSteps: 1,
          },
        ]
      : [],
    completedSteps: 0,
    totalSteps: 1,
    currentPhase: null,
    currentStep: null,
    operations: Array.isArray(operations) ? operations : [operations],
  };
}

test('keeps reported execution and output freshness distinct from proof success', () => {
  const text = litText(renderOperationPanel(progress(operation), 'run-id', now));
  assert.match(text, /Last worker command/);
  assert.match(text, /Command running/);
  assert.match(text, /No recent status update/);
  assert.match(text, /none recorded/);
  assert.match(text, /View operation log/);
  assert.doesNotMatch(text, /Passed|Healthy/);
});
test('completed command duration stops at completion', () => {
  const text = litText(
    renderOperationPanel(
      progress({ ...operation, status: 'pass', finishedAt: '2026-09-29T01:00:05Z' }),
      'run-id',
      now,
    ),
  );
  assert.match(text, /Command completed/);
  assert.match(text, /5s/);
  assert.doesNotMatch(text, /No recent status update/);
});

test('a bare harness subcommand never reads as the run verdict', () => {
  const text = litText(
    renderOperationPanel(
      progress({ ...operation, command: 'run', status: 'fail', finishedAt: operation.updatedAt }),
      'run-id',
      now,
    ),
  );
  assert.match(text, /Last worker command/);
  assert.match(text, /harness run/);
  assert.match(text, /Command failed/);
  assert.doesNotMatch(text, />\s*Failed\s*</, 'no bare Failed badge');
  assert.doesNotMatch(text, /run still in progress/, 'no open step, so no softening');
  const full = litText(
    renderOperationPanel(progress({ ...operation, command: 'mm-harness run' }), 'run-id', now),
  );
  assert.match(full, /mm-harness run/);
  assert.doesNotMatch(full, /harness mm-harness/);
});

test('a failed command while the worker still has a step open is not shown as a run failure', () => {
  const failed = {
    ...operation,
    command: 'run',
    status: 'fail' as const,
    finishedAt: operation.updatedAt,
  };
  const result = renderOperationPanel(progress(failed, 'running'), 'run-id', now);
  const text = litText(result);
  assert.match(text, /Command failed/);
  assert.match(text, /run still in progress/);
  assert.match(text, /operation-status fail in-progress/, 'amber, not red');
  assert.doesNotMatch(
    litText(renderOperationPanel(progress(failed, 'done'), 'run-id', now)),
    /in-progress/,
  );
});

test('a late heartbeat never swaps the running command for an older failed one', () => {
  // Failed op A, then running op B whose last heartbeat is 45 s old, listed in
  // an order that is not by start time. The panel shows B, never A.
  const failedA: TaskOperation = {
    ...operation,
    id: 'a',
    command: 'run',
    status: 'fail',
    startedAt: '2026-09-29T00:58:00Z',
    updatedAt: '2026-09-29T00:59:00Z',
    finishedAt: '2026-09-29T00:59:00Z',
    logPath: 'artifacts/operations/a.log',
  };
  const runningB: TaskOperation = {
    ...operation,
    id: 'b',
    command: 'run',
    status: 'running',
    startedAt: '2026-09-29T00:59:30Z',
    updatedAt: '2026-09-29T00:59:55Z', // 45 s before `now`
    logPath: 'artifacts/operations/b.log',
  };
  assert.deepEqual(
    selectOperations([runningB, failedA], now).map((op) => op.id),
    ['b'],
  );
  for (const order of [
    [failedA, runningB],
    [runningB, failedA],
  ]) {
    const text = litText(renderOperationPanel(progress(order), 'run-id', now));
    assert.match(text, /Command running/);
    assert.match(text, /No recent status update/);
    assert.doesNotMatch(text, /Command failed/);
    assert.match(text, /operations%2Fb\.log/);
  }
});

test('with nothing running, the latest command by start time is shown', () => {
  const older = {
    ...operation,
    id: 'old',
    status: 'pass' as const,
    startedAt: '2026-09-29T00:50:00Z',
    finishedAt: '2026-09-29T00:51:00Z',
  };
  const newer = {
    ...operation,
    id: 'new',
    status: 'fail' as const,
    startedAt: '2026-09-29T00:55:00Z',
    finishedAt: '2026-09-29T00:56:00Z',
  };
  assert.deepEqual(
    selectOperations([newer, older]).map((op) => op.id),
    ['new'],
  );
});

test('a killed command whose record still says running does not bury the current one', () => {
  // Seen live on TAT-3991: `doctor` was killed without finalizing its record, so
  // it reads "running" with a heartbeat minutes old while `run` works.
  const deadDoctor: TaskOperation = {
    ...operation,
    id: 'doctor',
    command: 'doctor',
    status: 'running',
    startedAt: '2026-09-29T00:56:00Z',
    updatedAt: '2026-09-29T00:56:00Z',
  };
  const currentRun: TaskOperation = {
    ...operation,
    id: 'run',
    command: 'run',
    status: 'running',
    startedAt: '2026-09-29T01:00:20Z',
    updatedAt: '2026-09-29T01:00:39Z',
  };
  const freshParent: TaskOperation = {
    ...operation,
    id: 'parent',
    command: 'checklist',
    status: 'running',
    startedAt: '2026-09-29T01:00:10Z',
    updatedAt: '2026-09-29T01:00:38Z',
  };
  assert.deepEqual(
    selectOperations([deadDoctor, currentRun, freshParent], now).map((op) => op.id),
    ['parent', 'run'],
    'fresh running commands stay; the dead older one does not',
  );
  assert.deepEqual(
    selectOperations([deadDoctor], now).map((op) => op.id),
    ['doctor'],
    'when it is the latest thing that happened, it is shown (marked stale)',
  );
});
