import assert from 'node:assert/strict';
import test from 'node:test';

import type { TaskStepSubtaskProgress } from '@farmslot/protocol';
import { colors } from '@farmslot/theme';

import {
  subtaskBlockKey,
  subtaskProgressView,
  subtaskStatusColor,
  taskStepStatusColor,
} from './task-progress-view';

function unit(overrides: Partial<TaskStepSubtaskProgress> = {}): TaskStepSubtaskProgress {
  return {
    id: 'perps-review',
    status: 'running',
    source: {
      kind: 'skill',
      ref: '.agents/skills/mms-perps-review-pr/skill.md',
      sha256: 'a',
      renderedSha256: 'b',
    },
    progress: {
      schema: { flowType: 'subtask', title: 'Review', totalSteps: 2, phases: [] },
      phases: [],
      completedSteps: 1,
      totalSteps: 2,
      currentPhase: 'Review',
      currentStep: 'Check the state derivation',
    },
    lastEventAt: '2026-09-19T10:58:00Z',
    ...overrides,
  };
}

test('a running unit shows its source basename, counts, and current step', () => {
  const view = subtaskProgressView(unit());
  assert.equal(view.title, 'skill.md');
  assert.equal(view.counts, '1/2');
  assert.equal(view.currentStep, 'Check the state derivation');
  assert.equal(view.staleNote, null);
  assert.equal(view.settled, false);
  assert.equal(view.color, colors.accent);
});

test('an inline unit has no ref to show', () => {
  const view = subtaskProgressView(
    unit({ source: { kind: 'inline', sha256: 'a', renderedSha256: 'b' } }),
  );
  assert.equal(view.title, 'inline');
});

test('a stale unit names the last child mark in visible text, not a tooltip', () => {
  const view = subtaskProgressView(unit({ status: 'stale' }));
  assert.equal(view.staleNote, 'no mark since 2026-09-19T10:58:00Z');
  assert.equal(view.color, colors.statusWarn);
  assert.equal(view.settled, false);
});

test('blocked keeps ownership, complete settles', () => {
  assert.equal(subtaskProgressView(unit({ status: 'blocked' })).settled, false);
  assert.equal(subtaskProgressView(unit({ status: 'complete' })).settled, true);
  assert.equal(subtaskStatusColor('blocked'), colors.statusFail);
  assert.equal(subtaskStatusColor('complete'), colors.statusOk);
});

test('step colours match the parent checklist rows', () => {
  assert.equal(taskStepStatusColor('done'), colors.statusOk);
  assert.equal(taskStepStatusColor('running'), colors.statusWarn);
  assert.equal(taskStepStatusColor('skipped'), colors.textMuted);
  assert.equal(taskStepStatusColor('pending'), colors.accent);
});

test('the block key changes with the run so a run change remounts it', () => {
  assert.equal(subtaskBlockKey('run-a', 'perps-review'), 'run-a:perps-review');
  assert.notEqual(
    subtaskBlockKey('run-a', 'perps-review'),
    subtaskBlockKey('run-b', 'perps-review'),
    'the same unit id in another run must not reuse the mounted block',
  );
  assert.equal(
    subtaskBlockKey('run-a', 'perps-review'),
    subtaskBlockKey('run-a', 'perps-review'),
    'the same run and unit keep one block across re-renders',
  );
});

test('a missing run falls back to one shared key', () => {
  assert.equal(subtaskBlockKey(null, 'ci-parity'), 'no-run:ci-parity');
  assert.equal(subtaskBlockKey(undefined, 'ci-parity'), 'no-run:ci-parity');
  assert.equal(subtaskBlockKey('  ', 'ci-parity'), 'no-run:ci-parity');
});
