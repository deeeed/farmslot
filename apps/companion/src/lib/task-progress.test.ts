import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import {
  activeTaskProgressStepId,
  buildCiFixTaskProgress,
  fallbackTaskProgressSummary,
  isSlotWorkerProgressActive,
  isWorkerProgressActive,
  shouldAcceptTaskProgressUpdate,
} from './task-progress';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'monitoring',
    project: 'example-mobile',
    ticketOrPr: 'PR-1',
    slotId: 'slot-1',
    branch: 'main',
    taskFile: '/repo/TASK.md',
    steps: [{ name: 'monitor', status: 'running' }],
    decisions: [],
    metrics: { nudgeCount: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Run;
}

test('detects active worker progress for monitor-like states', () => {
  assert.equal(isWorkerProgressActive(makeRun()), true);
  assert.equal(isWorkerProgressActive(makeRun({ status: 'done', steps: [] })), false);
  assert.equal(
    isWorkerProgressActive(
      makeRun({ status: 'done', activeTaskFile: '/repo/SELF-REVIEW.md', steps: [] }),
    ),
    true,
  );
});

test('detects active slot worker task progress before run hydration', () => {
  assert.equal(
    isSlotWorkerProgressActive({
      lifecycle: 'busy',
      phase: 'working',
      taskPhase: null,
      taskStepProgress: null,
      activeTaskFile: undefined,
    }),
    true,
  );
  assert.equal(
    isSlotWorkerProgressActive({
      lifecycle: 'held',
      phase: 'ci-watch',
      taskPhase: 'CI fix 1/3',
      taskStepProgress: 1 / 3,
      activeTaskFile: undefined,
    }),
    true,
  );
  assert.equal(
    isSlotWorkerProgressActive({
      lifecycle: 'ready',
      phase: null,
      taskPhase: null,
      taskStepProgress: null,
      activeTaskFile: undefined,
    }),
    false,
  );
});

test('accepts only progress updates for the matching run and active context', () => {
  const run = makeRun({ activeTaskFile: '/repo/SELF-REVIEW.md' });
  assert.equal(
    shouldAcceptTaskProgressUpdate(run, {
      slotId: 'slot-1',
      runId: 'run-1',
      role: 'self-review',
      contextId: 'self-review',
      progress: { slotId: 'slot-1', markdown: '' },
    }),
    true,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(run, {
      slotId: 'slot-1',
      runId: 'run-1',
      role: 'primary',
      contextId: 'primary',
      progress: { slotId: 'slot-1', markdown: '' },
    }),
    false,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(run, {
      slotId: 'slot-1',
      runId: 'other-run',
      progress: { slotId: 'slot-1', markdown: '' },
    }),
    false,
  );
});

test('builds CI fix progress from ci-watch outputs', () => {
  const progress = buildCiFixTaskProgress(
    makeRun({
      status: 'ci-watching',
      steps: [
        {
          name: 'ci-watch',
          status: 'running',
          outputs: {
            phase: 'fixing',
            fixInProgress: true,
            fixProgress: { completed: 1, total: 3, currentLabel: 'Patch failing test' },
          },
        },
      ],
    }),
  );
  assert.equal(progress?.completedSteps, 1);
  assert.equal(progress?.totalSteps, 3);
  assert.equal(progress?.currentStep, 'Patch failing test');
});

test('identifies the active progress lane', () => {
  assert.equal(activeTaskProgressStepId(makeRun(), undefined), null);
  assert.equal(
    activeTaskProgressStepId(
      makeRun({
        status: 'ci-watching',
        steps: [
          {
            name: 'ci-watch',
            status: 'running',
            outputs: {
              phase: 'waiting_for_worker',
              fixInProgress: true,
              fixProgress: { completed: 0, total: 2, currentLabel: 'Inspect logs' },
            },
          },
        ],
      }),
      undefined,
    ),
    'ci-watch',
  );
});

test('builds fallback progress summary from slot task phase before structured checklist arrives', () => {
  const summary = fallbackTaskProgressSummary(makeRun({ activeTaskFile: '/repo/SELF-REVIEW.md' }), {
    phase: 'working',
    taskPhase: 'Validate 2/5',
    taskStepProgress: 0.4,
    activeTaskFile: '/repo/SELF-REVIEW.md',
  });

  assert.equal(summary.title, 'Self-review progress');
  assert.equal(summary.meta, 'Validate 2/5');
  assert.equal(summary.percent, 40);
});

test('builds fallback progress summary from running run step when slot phase is absent', () => {
  const summary = fallbackTaskProgressSummary(
    makeRun({
      status: 'monitoring',
      steps: [{ name: 'monitor', status: 'running', detail: 'Watching PR checks' }],
    }),
  );

  assert.equal(summary.title, 'Worker progress');
  assert.equal(summary.meta, 'Watching PR checks');
  assert.equal(summary.percent, null);
});
