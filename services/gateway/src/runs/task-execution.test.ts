import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext, Run, RunTaskExecution } from '@farmslot/protocol';

import { qaEvidenceStartedAt, taskExecutionAtDispatch } from './task-execution.js';

const taskFile = '/farm/projects/ext/tasks/qa/release-1016-232047/TASK.md';
const written = '2026-10-16T15:19:29.722Z';
const launched = '2026-10-16T15:22:53.489Z';
const replayed = '2026-10-16T19:10:58.213Z';

function qaRun(overrides: {
  taskExecution?: RunTaskExecution;
  primary?: Partial<AgentContext>;
  writtenAt?: string;
}) {
  const primary: AgentContext = {
    id: 'primary',
    runId: 'run-1',
    slotId: 'macpro-mme-4',
    role: 'primary',
    label: 'Primary',
    status: 'blocked',
    runner: 'claude',
    model: 'opus',
    taskFile: 'temp/tasks/qa/release-1016-232047/TASK.md',
    startedAt: launched,
    ...overrides.primary,
  };
  return {
    flowType: 'qa',
    taskFile,
    startedAt: '2026-10-16T13:50:36.961Z',
    createdAt: '2026-10-16T13:50:36.000Z',
    steps: [
      { name: 'write-task', status: 'done', startedAt: overrides.writtenAt ?? written },
      { name: 'dispatch', status: 'running', startedAt: replayed },
    ],
    engineState: overrides.taskExecution ? { taskExecution: overrides.taskExecution } : {},
    agentContexts: overrides.primary === undefined ? [] : [primary],
  } satisfies Pick<
    Run,
    'flowType' | 'taskFile' | 'steps' | 'engineState' | 'agentContexts' | 'startedAt' | 'createdAt'
  >;
}

test('a dispatch replay resuming the anchored task keeps its evidence window', () => {
  const run = qaRun({ taskExecution: { taskFile, startedAt: '2026-10-16T15:22:30.000Z' } });
  assert.equal(taskExecutionAtDispatch(run), null);
  assert.equal(qaEvidenceStartedAt(run), '2026-10-16T15:22:30.000Z');
  // A mirror import rebases roots but keeps the flow and task folder.
  const mirrored = qaRun({
    taskExecution: {
      taskFile: '/mirror/tasks/qa/release-1016-232047/TASK.md',
      startedAt: launched,
    },
  });
  assert.equal(qaEvidenceStartedAt(mirrored), launched);
});

test('a new task identity opens its window at its own dispatch', () => {
  const earlier = {
    taskFile: '/farm/projects/ext/tasks/qa/release-1016-215019/TASK.md',
    startedAt: launched,
  };
  assert.deepEqual(taskExecutionAtDispatch(qaRun({ taskExecution: earlier })), {
    taskFile,
    startedAt: replayed,
  });
  assert.equal(qaEvidenceStartedAt(qaRun({ taskExecution: earlier })), replayed);
  // First dispatch of a new run: no worker context yet.
  assert.deepEqual(taskExecutionAtDispatch(qaRun({})), { taskFile, startedAt: replayed });
  assert.equal(qaEvidenceStartedAt(qaRun({})), replayed);
});

test('a pre-anchor run keeps its original launch through a later dispatch replay', () => {
  const legacy = qaRun({ primary: {} });
  assert.equal(qaEvidenceStartedAt(legacy), launched);
  const anchor = taskExecutionAtDispatch(legacy);
  assert.deepEqual(anchor, { taskFile, startedAt: launched });
  assert.ok(anchor);
  assert.equal(qaEvidenceStartedAt(qaRun({ primary: {}, taskExecution: anchor })), launched);
});

test('the pre-anchor launch counts only for the current task, after it was written', () => {
  for (const run of [
    // write-task replay: the context kept its first launch from the previous task.
    qaRun({ primary: {}, writtenAt: '2026-10-16T16:30:00.000Z' }),
    qaRun({ primary: { taskFile: 'temp/tasks/qa/other-1016-232047/TASK.md' } }),
    qaRun({ primary: { role: 'review' } }),
    qaRun({ primary: { startedAt: '2026-10-16T19:30:00.000Z' } }),
    qaRun({ primary: { startedAt: 'not a time' } }),
  ]) {
    assert.equal(qaEvidenceStartedAt(run), replayed);
    assert.deepEqual(taskExecutionAtDispatch(run), { taskFile, startedAt: replayed });
  }
});
