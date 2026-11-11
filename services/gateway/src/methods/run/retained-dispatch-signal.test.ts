import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentContext } from '@farmslot/protocol';

import { makeVars } from '../../runners/test-fixtures.js';

import { makeRun } from './test-fixtures.js';

await import('../../runtime/mock-pty.test-support.js');
const { retainedDispatchSignal } = await import('./retained-dispatch-signal.js');

function fixture() {
  const run = makeRun({
    id: 'retained-run',
    slotId: 'slot-1',
    flowType: 'dev',
    taskFile: '/mirror/original/TASK.md',
  });
  run.engineState = { taskInit: { taskFile: run.taskFile!, status: 'initialized' } };
  run.steps = [{ name: 'dispatch', status: 'failed', startedAt: '2026-11-11T15:00:00.000Z' }];
  const context: AgentContext = {
    id: 'dev',
    role: 'dev',
    label: 'Dev',
    status: 'blocked',
    runId: run.id,
    slotId: run.slotId,
    runner: 'claude',
    model: 'haiku',
    target: { paneId: '%1', session: 'fixture', target: 'fixture:dev' },
    runnerSessionId: 'same-session',
    runnerSessionPath: '/sessions/original.jsonl',
    taskFile: 'tasks/original/TASK.md',
    signalFile: 'tasks/original/SIGNAL.json',
    signalAttemptId: 'same-attempt',
    attemptStartedAt: '2026-11-11T14:00:00.000Z',
    nudgeCount: 0,
  };
  const signal = {
    status: 'running',
    attemptId: 'same-attempt',
    timestamp: '2026-11-11T14:30:00.000Z',
  };
  const vars = makeVars({ slotId: 'slot-1' });
  return { run, context, signal, vars };
}

type Deps = NonNullable<Parameters<typeof retainedDispatchSignal>[4]>;
const healthy: Deps = {
  taskDir: async () => 'tasks/original',
  pane: async () => ({ paneId: '%1', panePid: '100' }),
  probe: async () => ({ state: 'present', pid: '101' }),
  binding: async (_vars, _runner, expected) => {
    assert.equal(expected.expectedSessionId, 'same-session');
    assert.equal(expected.expectedSessionPath, '/sessions/original.jsonl');
    assert.equal(expected.runnerPid, '101');
    return {
      ok: true,
      binding: {
        runnerSessionId: 'same-session',
        runnerSessionPath: '/sessions/original.jsonl',
        source: 'native',
        canonicalSessionPath: '/sessions/original.jsonl',
      },
    };
  },
};

test('a live original worker is adopted across a later refused dispatch, keeping its attempt', async () => {
  const { run, context, vars, signal } = fixture();
  assert.deepEqual(await retainedDispatchSignal(run, context, vars, signal, healthy), signal);
  assert.equal(context.runnerSessionId, 'same-session');
  assert.equal(run.steps[0].status, 'failed', 'adoption admission does not mutate the run');
});

test('foreign or missing signals keep a live worker fenced rather than authorizing replacement', async () => {
  for (const signal of [
    undefined,
    { status: 'running', attemptId: 'foreign', timestamp: '2026-11-11T14:30:00.000Z' },
    { status: 'running', attemptId: 'same-attempt', timestamp: '2026-11-11T13:30:00.000Z' },
  ]) {
    const { run, context, vars } = fixture();
    await assert.rejects(
      retainedDispatchSignal(run, context, vars, signal, healthy),
      /signal does not match/,
    );
  }
});

test('a mismatched live session refuses; a confirmed absent worker keeps ordinary replay', async () => {
  const { run, context, vars, signal } = fixture();
  await assert.rejects(
    retainedDispatchSignal(run, context, vars, signal, {
      ...healthy,
      probe: async () => ({ state: 'unknown', code: 'probe-timeout' }),
    }),
    /liveness is unconfirmed/,
  );
  await assert.rejects(
    retainedDispatchSignal(run, context, vars, signal, {
      ...healthy,
      binding: async () => ({ ok: false, reason: 'different session' }),
    }),
    /identity is unconfirmed/,
  );
  assert.equal(
    await retainedDispatchSignal(run, context, vars, signal, {
      ...healthy,
      probe: async () => ({ state: 'absent' }),
    }),
    null,
  );
});

test('a different run, slot, role, task or newer attempt cannot borrow an old worker', async () => {
  for (const change of [{ runId: 'foreign' }, { slotId: 'foreign' }, { role: 'review' as const }]) {
    const { run, context, vars, signal } = fixture();
    assert.equal(
      await retainedDispatchSignal(run, { ...context, ...change }, vars, signal, {
        ...healthy,
        pane: async () => {
          throw new Error('No process probe should run');
        },
      }),
      null,
    );
  }
  const { run, context, vars, signal } = fixture();
  await assert.rejects(
    retainedDispatchSignal(
      run,
      { ...context, taskFile: 'tasks/foreign/TASK.md' },
      vars,
      signal,
      healthy,
    ),
    /current task/,
  );
  await assert.rejects(
    retainedDispatchSignal(
      run,
      { ...context, attemptStartedAt: '2026-11-11T15:01:00.000Z' },
      vars,
      signal,
      healthy,
    ),
    /original attempt identity/,
  );
});

test('a regenerated current task cannot adopt the old worker and both old context paths', async () => {
  const { run, context, vars, signal } = fixture();
  run.taskFile = '/mirror/new-task/TASK.md';
  run.engineState = { taskInit: { taskFile: run.taskFile, status: 'initialized' } };
  await assert.rejects(
    retainedDispatchSignal(run, context, vars, signal, {
      ...healthy,
      taskDir: async () => 'tasks/new-task',
    }),
    /current task/,
  );
});

test('missing session identity preserves a live worker but permits confirmed absence', async () => {
  for (const missing of [{ runnerSessionId: null }, { runnerSessionPath: null }]) {
    const { run, context, vars, signal } = fixture();
    await assert.rejects(
      retainedDispatchSignal(run, { ...context, ...missing }, vars, signal, healthy),
      /identity is incomplete/,
    );
    assert.equal(
      await retainedDispatchSignal(run, { ...context, ...missing }, vars, signal, {
        ...healthy,
        probe: async () => ({ state: 'absent' }),
      }),
      null,
    );
  }
  const { run, context, vars, signal } = fixture();
  await assert.rejects(
    retainedDispatchSignal(run, context, vars, signal, { ...healthy, pane: async () => null }),
    /liveness is unconfirmed/,
  );
});
