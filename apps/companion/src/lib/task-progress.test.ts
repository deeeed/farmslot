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
  taskProgressUpdateTargetsRun,
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

test('a progress update targets the run it names, slot run or review workspace', () => {
  const slotRun = makeRun();
  // A static review workspace run (ADR-058) has no slot; its progress publishes
  // with an empty slot id, which used to fail against a null slotId.
  const workspaceRun = makeRun({
    id: 'run-workspace',
    slotId: null,
    flowType: 'review-pr',
    reviewWorkspace: {
      workspaceId: 'workspace-1',
      machine: 'macwork',
      executionNodeId: 'local',
      checkoutPath: '/repo',
      taskPath: '/repo/task',
      artifactPath: '/repo/task/artifacts',
    },
  } as Partial<Run>);
  const workspaceUpdate = { slotId: '', runId: 'run-workspace' };

  assert.equal(taskProgressUpdateTargetsRun(slotRun, { slotId: 'slot-1', runId: 'run-1' }), true);
  assert.equal(taskProgressUpdateTargetsRun(slotRun, { slotId: 'slot-2', runId: 'run-1' }), false);
  assert.equal(taskProgressUpdateTargetsRun(workspaceRun, workspaceUpdate), true);
  assert.equal(taskProgressUpdateTargetsRun(slotRun, workspaceUpdate), false);
  assert.equal(taskProgressUpdateTargetsRun(null, workspaceUpdate), false);

  // The whole rule, protocol checklist check included.
  assert.equal(
    shouldAcceptTaskProgressUpdate(workspaceRun, {
      ...workspaceUpdate,
      role: 'review',
      contextId: 'review',
      progress: { slotId: '', markdown: '' },
    }),
    true,
  );
  assert.equal(
    shouldAcceptTaskProgressUpdate(slotRun, {
      ...workspaceUpdate,
      role: 'review',
      contextId: 'review',
      progress: { slotId: '', markdown: '' },
    }),
    false,
  );
  // A workspace run is live for progress even though it has no slot.
  assert.equal(isWorkerProgressActive(workspaceRun), true);
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

test('the shared protocol rule places a child unit update and every role checklist', () => {
  const base = { slotId: 'slot-1', runId: 'run-1', progress: { slotId: 'slot-1', markdown: '' } };
  const selfReviewRun = makeRun({ activeTaskFile: '/repo/SELF-REVIEW.md' });
  const ciFixRun = makeRun({ activeTaskFile: '/repo/CI-FIX.md' });
  const workerRun = makeRun({ activeTaskFile: '/repo/TASK.md' });

  // The replaced local filter only knew SELF-REVIEW.md and returned true for
  // every other role checklist, so a stale ci-fix update used to be accepted.
  assert.equal(shouldAcceptTaskProgressUpdate(ciFixRun, { ...base, contextId: 'ci-fix' }), true);
  assert.equal(
    shouldAcceptTaskProgressUpdate(ciFixRun, { ...base, contextId: 'self-review' }),
    false,
  );

  // A child checklist unit is accepted while its parent checklist is the active one.
  const child = (parentChecklist: string) => ({
    ...base,
    role: 'subtask' as const,
    contextId: 'perps-review',
    parentChecklist,
  });
  assert.equal(shouldAcceptTaskProgressUpdate(workerRun, child('CHECKLIST.md')), true);
  assert.equal(shouldAcceptTaskProgressUpdate(selfReviewRun, child('SELF-REVIEW.md')), true);
  assert.equal(shouldAcceptTaskProgressUpdate(selfReviewRun, child('CHECKLIST.md')), false);
  assert.equal(shouldAcceptTaskProgressUpdate(workerRun, child('SELF-REVIEW.md')), false);

  // The slot/run identity pre-check still runs before the shared rule.
  assert.equal(
    shouldAcceptTaskProgressUpdate(workerRun, { ...child('CHECKLIST.md'), slotId: 'slot-9' }),
    false,
  );
});
