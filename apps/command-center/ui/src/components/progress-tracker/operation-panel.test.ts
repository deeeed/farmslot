import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskOperation, TaskProgressStructured } from '@farmslot/protocol';

import { litText } from '../../testing/lit-text.js';

import { renderOperationPanel } from './operation-panel.js';

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
function progress(operation: TaskOperation): TaskProgressStructured {
  return {
    schema: { flowType: 'qa', title: 'Proof', totalSteps: 0, phases: [] },
    phases: [],
    completedSteps: 0,
    totalSteps: 0,
    currentPhase: null,
    currentStep: null,
    operations: [operation],
  };
}

test('keeps reported execution and output freshness distinct from proof success', () => {
  const text = litText(renderOperationPanel(progress(operation), 'run-id', now));
  assert.match(text, /Running reported/);
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
  assert.match(text, /Completed/);
  assert.match(text, /5s/);
  assert.doesNotMatch(text, /No recent status update/);
});
