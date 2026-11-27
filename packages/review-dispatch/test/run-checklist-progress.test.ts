import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type Run,
  runListRow,
  type TaskProgressStructured,
  type TaskProgressUpdatedPayload,
  trimRunForList,
} from '@farmslot/protocol';

import {
  checklistProgressExecution,
  checklistProgressIsLive,
  checklistProgressView,
} from '../src/checklist-progress.js';
import {
  acceptsRunChecklistProgress,
  runChecklistProgressSummary,
  runChecklistProgressTarget,
  runChecklistProgressView,
} from '../src/run-checklist-progress.js';

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    familyId: 'family-1',
    lane: 'production',
    flowType: 'dev',
    status: 'reviewing',
    project: 'fixture',
    ticketOrPr: 'TEST-1',
    slotId: 'slot-1',
    branch: 'fix/test',
    taskFile: 'tasks/test/TASK.md',
    activeTaskFile: 'tasks/test/REVIEW.md',
    createdAt: '2026-10-22T10:00:00Z',
    updatedAt: '2026-10-22T10:01:00Z',
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-6.1-sol' },
    decisions: [],
    steps: [{ name: 'review', status: 'running' }],
    ...overrides,
  };
}

function progress(): TaskProgressStructured {
  const steps = Array.from({ length: 8 }, (_, index) => ({
    index: index + 1,
    name: `${index + 1}. Verify the proof`,
    status:
      index < 4 ? ('done' as const) : index === 4 ? ('running' as const) : ('pending' as const),
  }));
  return {
    schema: {
      flowType: 'dev',
      title: 'Review',
      totalSteps: 8,
      phases: [{ name: 'Review', steps }],
    },
    phases: [{ name: 'Review', completedSteps: 4, totalSteps: 8, steps }],
    completedSteps: 4,
    totalSteps: 8,
    currentStep: steps[4].name,
    currentPhase: 'Review',
  };
}

test('the current review checklist exposes the real 4/8 and item, not pipeline steps remaining', () => {
  const view = runChecklistProgressView(run(), progress());
  assert.equal(view?.counts, '4/8');
  assert.equal(view?.label, '5. Verify the proof');
  assert.equal(view?.percent, 50);
  assert.equal(view?.accessibleLabel, '4/8 checklist steps done · 5. Verify the proof');
});

test('no checklist data means no sub-bar; a finished run or idle human gate never reuses the old review', () => {
  assert.equal(runChecklistProgressView(run(), null), null);
  assert.equal(runChecklistProgressView(run(), { ...progress(), totalSteps: 0 }), null);
  for (const status of ['done', 'cancelled', 'failed'] as const)
    assert.equal(runChecklistProgressView(run({ status }), progress()), null);
  assert.equal(
    runChecklistProgressView(
      run({ status: 'human-gating', steps: [{ name: 'human-gate', status: 'running' }] }),
      progress(),
    ),
    null,
  );
});

test('list fetch identity follows role/checklist and replay attempt without changing the run id', () => {
  const source = run();
  const key = runChecklistProgressTarget(source)?.key;
  const fixed = run({ status: 'fixing', activeTaskFile: 'tasks/test/REVIEW-FIX.md' });
  assert.notEqual(runChecklistProgressTarget(fixed)?.key, key);
  const replayed = run({
    steps: [{ name: 'review', status: 'running', startedAt: '2026-10-22T10:15:00Z' }],
  });
  assert.notEqual(runChecklistProgressTarget(replayed)?.key, key);
});

test('slot-free review workspaces hydrate and accept only the matching run and active role', () => {
  const source = run({
    slotId: undefined,
    reviewWorkspace: {
      workspaceId: 'workspace-1',
      machine: 'fixture',
      executionNodeId: 'node-1',
      checkoutPath: '/fixture',
      taskPath: '/fixture/task',
      artifactPath: '/fixture/artifacts',
    },
  });
  assert.deepEqual(runChecklistProgressTarget(source)?.params, { slotId: '', runId: 'run-1' });
  const update: TaskProgressUpdatedPayload = {
    slotId: '',
    runId: source.id,
    role: 'review',
    contextId: 'review',
    progress: { slotId: '', markdown: '', structured: progress() },
  };
  assert.equal(acceptsRunChecklistProgress(source, update), true);
  assert.equal(acceptsRunChecklistProgress(source, { ...update, runId: 'another-run' }), false);
  assert.equal(acceptsRunChecklistProgress(source, { ...update, slotId: 'another-slot' }), false);
  assert.equal(
    acceptsRunChecklistProgress(source, { ...update, role: 'dev', contextId: 'dev' }),
    false,
  );
});

test('CI fixes use the existing recorded fix counts when no task projection has arrived', () => {
  const source = run({
    status: 'ci-watching',
    steps: [
      {
        name: 'ci-watch',
        status: 'running',
        outputs: {
          fixInProgress: true,
          fixProgress: { completed: 1, total: 3, currentLabel: 'Repair checks' },
        },
      },
    ],
  });
  const view = runChecklistProgressView(source, null);
  assert.equal(view?.counts, '1/3');
  assert.equal(view?.label, 'Repair checks');
  assert.equal(Math.round(view?.percent ?? 0), 33);
});

test('a missing currentStep uses the structured running item and a completed checklist has a clear label', () => {
  assert.equal(
    runChecklistProgressView(run(), { ...progress(), currentStep: null })?.label,
    '5. Verify the proof',
  );
  assert.equal(
    runChecklistProgressView(run(), {
      ...progress(),
      currentStep: null,
      completedSteps: 8,
      phases: [],
    })?.label,
    'Checklist complete',
  );
});

test('a worker event cannot replace a native reviewer checklist with an attempt-scoped filename', () => {
  const source = run({ activeTaskFile: 'tasks/test/REVIEW.native-attempt.md' });
  const update: TaskProgressUpdatedPayload = {
    slotId: 'slot-1',
    runId: source.id,
    role: 'review',
    contextId: 'native-attempt',
    progress: { slotId: 'slot-1', markdown: '', structured: progress() },
  };
  assert.equal(acceptsRunChecklistProgress(source, update), true);
  assert.equal(
    acceptsRunChecklistProgress(source, { ...update, role: 'dev', contextId: 'dev' }),
    false,
  );
});

test('a held review-fix observation stops its clock at the completed owner, including on reload', () => {
  const input = progress();
  input.timing = {
    schemaVersion: 1,
    source: 'REVIEW-FIX.md',
    startedAt: '2026-11-04T11:26:18.756Z',
    events: [],
  };
  const gate = run({
    status: 'blocked',
    activeTaskFile: 'tasks/test/REVIEW-FIX.md',
    steps: [
      { name: 'review', status: 'done' },
      { name: 'human-gate', status: 'running' },
    ],
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix',
        label: 'Review fix',
        status: 'complete',
        slotId: 'slot-1',
        runId: 'run-1',
        taskFile: 'tasks/test/REVIEW-FIX.md',
        signalFile: null,
        target: null,
        runner: null,
        model: null,
        nudgeCount: 0,
        updatedAt: '2026-11-04T11:33:36.963Z',
        attemptStartedAt: '2026-11-04T11:26:18.756Z',
        completedAt: '2026-11-04T11:33:36.963Z',
      },
    ],
  });
  const rowsAt = (value: Run, now: string) =>
    checklistProgressView(input, { run: value, nowMs: Date.parse(now) })!.phases[0].rows;
  assert.equal(checklistProgressIsLive(input, gate), false);
  const held = rowsAt(gate, '2026-11-04T12:39:00Z');
  assert.equal(held.find((row) => row.step.status === 'running')?.duration, '7m 18s');
  assert.equal(held.find((row) => row.step.status === 'running')?.live, false);
  assert.deepEqual(rowsAt(structuredClone(gate), '2026-11-04T13:39:00Z'), held);
  const child = progress();
  child.timing = { ...input.timing, source: 'subtasks/fix-proof.md' };
  input.phases[0].steps[1].subtask = {
    id: 'fix-proof',
    status: 'running',
    source: { kind: 'skill', ref: 'review', sha256: 'a', renderedSha256: 'b' },
    progress: child,
    lastEventAt: gate.updatedAt,
  };
  const nextReviewer = run({
    status: 'reviewing',
    activeTaskFile: 'tasks/test/REVIEW.md',
    agentContexts: gate.agentContexts,
  });
  assert.equal(
    checklistProgressIsLive(input, nextReviewer),
    false,
    'the finished fix owns its child clock while another reviewer works',
  );

  input.phases[0].steps[1].subtask = undefined;
  input.timing.source = 'CHECKLIST.md';
  const finishedWorker = run({
    agentContexts: gate.agentContexts?.map((context) => ({
      ...context,
      id: 'dev',
      role: 'dev',
      taskFile: 'tasks/test/TASK.md',
    })),
  });
  assert.equal(
    checklistProgressIsLive(input, finishedWorker),
    false,
    'TASK and CHECKLIST belong to the same worker',
  );
  assert.equal(
    checklistProgressView(input, {
      run: finishedWorker,
      nowMs: Date.parse('2026-11-04T13:39:00Z'),
    })!.phases[0].rows.find((row) => row.step.status === 'running')?.duration,
    '7m 18s',
  );
  assert.equal(
    input.timing.finishedAt,
    undefined,
    'presentation does not mutate the cached observation',
  );
});

test('an idle gate without a recorded end never invents an elapsed time for stale running rows', () => {
  const input = progress();
  input.timing = {
    schemaVersion: 1,
    source: 'REVIEW-FIX.md',
    startedAt: '2026-11-04T11:26:18.756Z',
    events: [],
  };
  const gate = run({ status: 'blocked', steps: [{ name: 'human-gate', status: 'running' }] });
  assert.equal(checklistProgressIsLive(input, gate), false);
  const row = checklistProgressView(input, {
    run: gate,
    nowMs: Date.parse('2026-11-04T12:39:00Z'),
  })!.phases[0].rows.find((entry) => entry.step.status === 'running');
  assert.equal(row?.duration, null);
  assert.equal(row?.live, false);
});

// The CI-fix checklist strip reads ci-watch's fix progress: the same from the served row, the
// full run and an old cached row.
test('the CI-fix checklist is the same from the served slim row, the full run and an old cached row', () => {
  const full = run({
    status: 'ci-watching',
    steps: [
      {
        name: 'ci-watch',
        status: 'running',
        outputs: {
          phase: 'fixing',
          fixInProgress: true,
          fixProgress: { completed: 2, total: 4, currentLabel: 'Re-run the failing suite' },
          checkTimeline: [{ timestamp: '2026-10-22T10:00:00Z', status: 'failed' }],
        },
      },
    ],
  });
  const expected = runChecklistProgressView(full, null);
  assert.deepEqual([expected?.completed, expected?.total], [2, 4]);
  assert.deepEqual(runChecklistProgressView(runListRow(full), null), expected);
  assert.deepEqual(runChecklistProgressView(trimRunForList(full), null), expected);
});

test('worker acknowledgement uses the first accepted signal, never the launch or latest mark', () => {
  const input = progress();
  input.completedSteps = 0;
  input.phases[0].completedSteps = 0;
  input.phases[0].steps.forEach((step) => {
    step.status = 'pending';
  });
  input.timing = {
    schemaVersion: 1,
    source: 'CHECKLIST.md',
    events: [],
    startedAt: '2026-11-16T01:00:00Z',
  };
  const current = run({
    status: 'monitoring',
    activeTaskFile: undefined,
    steps: [{ name: 'monitor', status: 'running' }],
    agentContexts: [
      {
        id: 'worker',
        role: 'dev',
        label: 'Worker',
        status: 'launching',
        runId: 'run-1',
        slotId: 'slot-1',
        taskFile: 'tasks/test/TASK.md',
        startedAt: '2026-11-16T00:59:00Z',
        attemptStartedAt: '2026-11-16T01:00:00Z',
      },
    ],
  });
  assert.equal(checklistProgressExecution(input, current)?.acknowledgedAt, undefined);
  const context = current.agentContexts![0];
  context.status = 'working';
  context.signalAttemptId = 'observed-attempt';
  context.attemptStartedAt = '2026-11-16T01:00:07Z';
  context.lastSignalAt = '2026-11-16T01:00:07Z';
  assert.equal(checklistProgressExecution(input, current)?.acknowledgedAt, '2026-11-16T01:00:07Z');
  assert.equal(runChecklistProgressView(current, input)?.counts, '0/8');
  context.lastSignalAt = '2026-11-16T01:01:15Z';
  assert.equal(checklistProgressExecution(input, current)?.acknowledgedAt, '2026-11-16T01:00:07Z');
  current.agentContexts!.push({
    ...context,
    id: 'nested',
    role: 'subtask',
    taskFile: 'tasks/test/subtasks/nested/CHECKLIST.md',
    attemptStartedAt: '2026-11-16T01:02:00Z',
    lastSignalAt: '2026-11-16T01:02:00Z',
    signalAttemptId: 'nested-attempt',
  });
  assert.equal(checklistProgressExecution(input, current)?.acknowledgedAt, '2026-11-16T01:00:07Z');
  context.signalAttemptId = undefined;
  assert.equal(checklistProgressExecution(input, current)?.acknowledgedAt, undefined);
});

test('a review context with a launch-bound attempt does not claim worker acknowledgement', () => {
  const input = progress();
  input.timing = { schemaVersion: 1, source: 'REVIEW.md', events: [] };
  const review = run({
    agentContexts: [
      {
        id: 'review',
        role: 'review',
        label: 'Reviewer',
        status: 'working',
        runId: 'run-1',
        slotId: 'slot-1',
        taskFile: 'tasks/test/REVIEW.md',
        signalAttemptId: 'prebound-review-attempt',
        attemptStartedAt: '2026-11-16T01:00:00Z',
        lastSignalAt: '2026-11-16T01:00:07Z',
      },
    ],
  });
  assert.equal(checklistProgressExecution(input, review)?.active, true);
  assert.equal(checklistProgressExecution(input, review)?.acknowledgedAt, undefined);
});

test('a pre-bound reviewer cannot become the worker acknowledgement during a phase transition', () => {
  const input = progress();
  input.timing = { schemaVersion: 1, source: 'REVIEW.md', events: [] };
  const current = run({
    status: 'monitoring',
    steps: [{ name: 'monitor', status: 'running' }],
    agentContexts: [
      {
        id: 'review-transition',
        role: 'review',
        label: 'Reviewer',
        status: 'working',
        runId: 'run-1',
        slotId: 'slot-1',
        taskFile: 'tasks/test/REVIEW.md',
        signalAttemptId: 'prebound-review-attempt',
        attemptStartedAt: '2026-11-16T01:00:00Z',
        lastSignalAt: '2026-11-16T01:00:07Z',
      },
    ],
  });
  assert.equal(checklistProgressExecution(input, current)?.acknowledgedAt, undefined);
});

test('the compact summary carries the recorded child of the running parent and keeps parent counts', () => {
  const input = progress();
  const active = input.phases[0].steps[4];
  const childSteps = [
    { index: 1, name: 'Child 1', status: 'done' as const },
    { index: 2, name: 'Child 2', status: 'running' as const },
    { index: 3, name: 'Child 3', status: 'pending' as const },
  ];
  active.subtask = {
    id: 'recipe-proof',
    status: 'running',
    lastEventAt: null,
    source: { kind: 'inline', sha256: 'a', renderedSha256: 'b' },
    progress: {
      schema: {
        flowType: 'subtask',
        title: 'Child',
        totalSteps: 3,
        phases: [{ name: 'Child', steps: childSteps }],
      },
      phases: [{ name: 'Child', completedSteps: 1, totalSteps: 3, steps: childSteps }],
      completedSteps: 1,
      totalSteps: 3,
      currentPhase: 'Child',
      currentStep: 'Child 2',
    },
  };
  const view = runChecklistProgressSummary(input);
  assert.equal(view?.counts, '4/8');
  assert.equal(view?.subtask, active.subtask);
  active.status = 'done';
  input.completedSteps = input.phases[0].completedSteps = 5;
  input.phases[0].steps[5].status = 'running';
  input.currentStep = input.phases[0].steps[5].name;
  active.subtask.status = 'complete';
  active.subtask.progress.completedSteps = 3;
  active.subtask.progress.phases[0].completedSteps = 3;
  active.subtask.progress.currentStep = null;
  for (const step of active.subtask.progress.phases[0].steps) step.status = 'done';
  assert.equal(runChecklistProgressSummary(input)?.subtask, undefined);
});

test('a list row summary renders the same strip without steps', () => {
  const view = runChecklistProgressSummary({
    completedSteps: 2,
    totalSteps: 5,
    currentPhase: 'Build',
    currentStep: '3. write the fix',
  });
  assert.equal(view?.counts, '2/5');
  assert.equal(view?.label, '3. write the fix');
  assert.equal(view?.subtask, undefined);
  assert.equal(
    runChecklistProgressSummary({
      completedSteps: 5,
      totalSteps: 5,
      currentPhase: null,
      currentStep: null,
    })?.label,
    'Checklist complete',
  );
});
