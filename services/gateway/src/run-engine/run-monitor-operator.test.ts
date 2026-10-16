// @farmslot:serial — owns temporary project and pool rows in this checkout.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import type { Run, WorkerSignal } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { farmslotRoot } from '../fleet/state.js';
import { createRun, getRun, loadAllRuns, persistRunNow, updateRun } from '../runs/store.js';

import {
  type MonitorObservations,
  monitorRun,
  rearmInteractiveHandoffAutoRecovery,
  resolveMonitorDecision,
} from './run-monitor.js';
import { deleteTestRunIfPresent } from './test-fixtures.js';
import { trackOpenQuestion } from './worker-question.js';

async function fixture(t: TestContext, consumedBeforeWaitMs = 2000) {
  const project = `operator-monitor-${randomUUID()}`;
  const projectDir = path.join(farmslotRoot, 'projects', project);
  const poolFile = path.join(farmslotRoot, 'pool', `${project}.json`);
  const worker = await mkdtemp(path.join(os.tmpdir(), 'operator-monitor-'));
  const taskDir = path.join(projectDir, 'tasks/dev/fixture');
  const signalFile = path.join(worker, 'SIGNAL.json');
  const slotId = `${project}-slot`;
  const controller = new AbortController();
  const executions: Array<ReturnType<typeof monitorRun>> = [];
  let ownedRunId: string | undefined;
  const previousOwner = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  t.signal.addEventListener('abort', () => controller.abort(), { once: true });
  t.after(async () => {
    controller.abort();
    for (const decision of (ownedRunId && getRun(ownedRunId)?.decisions) || []) {
      if (!decision.resolvedAt) resolveMonitorDecision(decision.id, 'abort');
    }
    await Promise.allSettled(executions);
    if (ownedRunId) await deleteTestRunIfPresent(ownedRunId);
    await rm(projectDir, { recursive: true, force: true });
    await rm(poolFile, { force: true });
    await rm(worker, { recursive: true, force: true });
    if (previousOwner === undefined) delete process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    else process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = previousOwner;
  });
  process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID = 'fixture-service';
  const run = createRun(
    {
      project,
      flowType: 'dev',
      mode: 'autonomous',
      ticketOrPr: 'WAIT-1',
      transport: 'native',
      runner: 'codex',
    },
    { nativeOwnerPrincipalId: 'fixture-service' },
  );
  ownedRunId = run.id;
  await mkdir(taskDir, { recursive: true });
  await mkdir(path.dirname(poolFile), { recursive: true });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      monitoring: {
        poll_interval_min: 1 / 60_000,
        stuck_timeout_min: 1 / 60_000,
        idle_timeout_min: 1 / 60_000,
        total_timeout_min: 1,
        max_nudges: 0,
      },
    }),
  );
  await writeFile(
    poolFile,
    JSON.stringify({
      machine: 'localhost',
      project,
      host: 'localhost',
      ssh_user: os.userInfo().username,
      platform: 'cli',
      os: 'darwin',
      slots: [{ id: slotId, enabled: true, repo: worker, session: slotId }],
    }),
  );
  const startedAt = new Date(Date.now() - 600_000).toISOString();
  const since = new Date(Date.parse(startedAt) + consumedBeforeWaitMs).toISOString();
  const waiting: WorkerSignal = {
    status: 'running',
    attemptId: 'owned-attempt',
    role: 'dev',
    contextId: 'worker',
    timestamp: new Date().toISOString(),
    waitingForOperator: { who: 'operator', reason: 'Approach review', since },
  };
  const writeSignal = async (signal: WorkerSignal) => writeFile(signalFile, JSON.stringify(signal));
  await writeSignal(waiting);
  await writeFile(path.join(taskDir, 'TASK.md'), '# Worker\n');
  updateRun(run.id, {
    status: 'monitoring',
    transport: 'native',
    slotId,
    taskFile: path.join(taskDir, 'TASK.md'),
    agentContexts: [
      {
        id: 'worker',
        role: 'dev',
        label: 'Worker',
        runner: 'codex',
        status: 'working',
        runId: run.id,
        slotId,
        signalAttemptId: 'owned-attempt',
        signalFile,
        taskFile: path.join(worker, 'TASK.md'),
        startedAt,
        attemptStartedAt: startedAt,
      },
    ],
    monitorState: {
      nudgeCount: 0,
      startedAt,
      lastPollAt: startedAt,
      lastStructuredProgressAt: startedAt,
    },
  });
  const start = (observations: MonitorObservations) => {
    const execution = monitorRun(run.id, slotId, controller.signal, observations);
    executions.push(execution);
    return execution;
  };
  return { run, controller, waiting, startedAt, since, start, writeSignal };
}

for (const phase of ['startup', 'after-idle'] as const) {
  test(
    `unknown worker evidence at ${phase} keeps monitoring without a handoff`,
    { timeout: 4000 },
    async (t) => {
      const f = await fixture(t);
      await f.writeSignal({ ...f.waiting, waitingForOperator: undefined });
      updateRun(f.run.id, { monitorState: undefined });
      let observations = 0;
      let classified = false;
      let abort: ReturnType<typeof setImmediate> | undefined;
      t.after(() => {
        if (abort) clearImmediate(abort);
      });
      await f.start({
        workerStatus: async () =>
          phase === 'startup' ? 'unknown' : ++observations === 1 ? 'working' : 'idle',
        waitForWorker: async () => {
          if (phase === 'after-idle') abort = setImmediate(() => f.controller.abort());
          return 'unknown';
        },
        violations: async () => {
          classified = true;
          f.controller.abort();
          return [];
        },
      });
      assert.equal(
        classified,
        true,
        'the monitor continues its poll instead of waiting for an operator',
      );
      assert.deepEqual(getRun(f.run.id)!.decisions, []);
      assert.equal(getRun(f.run.id)!.status, 'monitoring');
    },
  );
}

test(
  'a restored live wait suppresses nudges and timeout, and clears on monitor exit',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t, 200_000);
    updateRun(f.run.id, {
      waitingForOperator: {
        ...f.waiting.waitingForOperator!,
        contextId: 'worker',
        attemptId: 'owned-attempt',
      },
    });
    await persistRunNow(getRun(f.run.id)!, 'operator wait reload');
    await loadAllRuns();
    assert.equal(
      getRun(f.run.id)!.waitingForOperator,
      undefined,
      'restart never trusts a cached healthy label',
    );
    let observations = 0;
    const result = await f.start({
      workerStatus: async () => {
        if (++observations > 1) assert.equal(getRun(f.run.id)!.waitingForOperator?.who, 'operator');
        if (observations === 5) f.controller.abort();
        return 'working';
      },
      violations: async () => assert.fail('healthy operator wait must not be classified as stuck'),
    });
    assert.ok(result.pollCount >= 3);
    assert.deepEqual(result.violations, []);
    assert.equal(getRun(f.run.id)!.metrics.nudgeCount, 0);
    assert.deepEqual(getRun(f.run.id)!.decisions, []);
    assert.equal(getRun(f.run.id)!.waitingForOperator, undefined);
    assert.ok((getRun(f.run.id)!.monitorState?.operatorWaitMs ?? 0) >= 399_000);
  },
);

test(
  'resume excludes the retained wait and starts a fresh inactivity window without inventing progress',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t);
    let observations = 0;
    let resumed = false;
    await f.start({
      workerStatus: async () => {
        if (++observations === 3) {
          assert.equal(getRun(f.run.id)!.waitingForOperator?.who, 'operator');
          const now = new Date().toISOString();
          await f.writeSignal({
            ...f.waiting,
            waitingForOperator: undefined,
            timestamp: now,
            operatorWaitIntervals: [{ since: f.since, until: now }],
          });
        }
        return 'working';
      },
      violations: async (_run, _slot, state) => {
        resumed = true;
        assert.equal(getRun(f.run.id)!.waitingForOperator, undefined);
        assert.ok(state.operatorWaitMs >= 597_000);
        assert.ok(state.operatorResumedAt > Date.parse(f.startedAt));
        assert.equal(state.lastStructuredProgressAt, Date.parse(f.startedAt));
        f.controller.abort();
        return [];
      },
    });
    assert.equal(resumed, true);
    assert.equal(getRun(f.run.id)!.metrics.nudgeCount, 0);
  },
);

for (const fault of ['attempt', 'context', 'schema'] as const) {
  test(`a ${fault} mismatch cannot suppress monitoring`, { timeout: 4000 }, async (t) => {
    const f = await fixture(t);
    const signal = {
      ...f.waiting,
      ...(fault === 'attempt' ? { attemptId: 'foreign-attempt' } : {}),
      ...(fault === 'context' ? { contextId: 'foreign-context' } : {}),
      ...(fault === 'schema'
        ? { waitingForOperator: { ...f.waiting.waitingForOperator!, who: '' } }
        : {}),
    };
    await f.writeSignal(signal);
    let classified = false;
    await f.start({
      workerStatus: async () => 'working',
      violations: async (_run, _slot, state) => {
        classified = true;
        assert.equal(getRun(f.run.id)!.waitingForOperator, undefined);
        assert.equal(state.operatorWaitMs, 0);
        f.controller.abort();
        return [];
      },
    });
    assert.equal(classified, true);
  });
}

test(
  'a resume written while monitoring was offline restores its original inactivity clock once',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t);
    const until = new Date(Date.now() - 1000).toISOString();
    await f.writeSignal({
      ...f.waiting,
      waitingForOperator: undefined,
      timestamp: until,
      operatorWaitIntervals: [{ since: f.since, until }],
    });
    await persistRunNow(getRun(f.run.id)!, 'offline resume');
    await loadAllRuns();
    assert.equal(getRun(f.run.id)!.waitingForOperator, undefined);
    let polls = 0;
    await f.start({
      workerStatus: async () => 'working',
      violations: async (_run, _slot, state) => {
        assert.equal(state.operatorResumedAt, Date.parse(until));
        assert.equal(state.lastPaneChangeAt, Date.parse(until));
        assert.equal(state.lastStructuredProgressAt, Date.parse(f.startedAt));
        assert.ok(state.operatorWaitMs >= 596_000);
        if (++polls === 3) f.controller.abort();
        return [];
      },
    });
    assert.equal(polls, 3);
    assert.equal(getRun(f.run.id)!.metrics.nudgeCount, 0);
  },
);

for (const generationChanged of [false, true]) {
  test(
    `stopping an old monitor retains a replacement projection, generation changed=${generationChanged}`,
    { timeout: 4000 },
    async (t) => {
      const f = await fixture(t);
      let observations = 0;
      let replacement: Run['waitingForOperator'];
      await f.start({
        workerStatus: async () => {
          if (++observations === 2) {
            assert.ok(getRun(f.run.id)!.waitingForOperator);
            replacement = { ...getRun(f.run.id)!.waitingForOperator! };
            updateRun(f.run.id, {
              waitingForOperator: replacement,
              ...(generationChanged ? { engineState: { generation: 1 } } : {}),
            });
            f.controller.abort();
          }
          return 'working';
        },
      });
      assert.equal(getRun(f.run.id)!.waitingForOperator, replacement);
    },
  );
}

test(
  'uncertain liveness clears a stored wait before worker recovery',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t);
    updateRun(f.run.id, {
      waitingForOperator: {
        ...f.waiting.waitingForOperator!,
        contextId: 'worker',
        attemptId: 'owned-attempt',
      },
    });
    let recoveryObserved = false;
    await f.start({
      workerStatus: async () => 'unknown',
      waitForWorker: async () => {
        recoveryObserved = true;
        assert.equal(getRun(f.run.id)!.waitingForOperator, undefined);
        f.controller.abort();
        return 'working';
      },
    });
    assert.equal(recoveryObserved, true);
    assert.equal(getRun(f.run.id)!.waitingForOperator, undefined);
  },
);

test('an explicit pause removes the live wait projection', { timeout: 4000 }, async (t) => {
  const f = await fixture(t);
  let observations = 0;
  await f.start({
    workerStatus: async () => {
      if (++observations === 2) {
        assert.ok(getRun(f.run.id)!.waitingForOperator);
        updateRun(f.run.id, { status: 'paused' });
        f.controller.abort();
      }
      return 'working';
    },
  });
  assert.equal(getRun(f.run.id)!.status, 'paused');
  assert.equal(getRun(f.run.id)!.waitingForOperator, undefined);
});

test(
  'an open worker question raises an interactive handoff with the question and clears when answered',
  { timeout: 4000 },
  async (t) => {
    // QA run 3e2f400a sat in monitoring with no decision while its worker asked a question.
    const f = await fixture(t);
    await f.writeSignal({ ...f.waiting, waitingForOperator: undefined });
    const question = 'Detach the checkout to the frozen scope head before testing?';
    let open: boolean | 'unreadable' = true;
    let nudgeable = 0;
    let unreadableProbes = 0;
    const execution = f.start({
      workerStatus: async () => 'working',
      violations: async (_run, _slot, state) => {
        if (trackOpenQuestion(state, open ? question : null, true) === null) nudgeable++;
        return [];
      },
      question: async () => {
        if (open === 'unreadable') {
          unreadableProbes++;
          throw new Error('worker pane capture is empty');
        }
        return open ? question : null;
      },
    });
    const handoff = async () => {
      for (let i = 0; i < 200; i++) {
        const decision = getRun(f.run.id)!.decisions.find(
          (entry) => entry.type === 'monitor_interactive_handoff',
        );
        if (decision) return decision;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return assert.fail('no handoff for the open question');
    };
    const decision = await handoff();
    assert.match(
      decision.description,
      new RegExp(`\`\`\`text\n${question.replace(/\?/g, '\\?')}\n\`\`\``),
    );
    assert.equal(getRun(f.run.id)!.status, 'blocked');
    assert.equal(nudgeable, 0, 'an open question is never classified for a nudge');
    assert.equal(decision.context?.workerQuestion, true);
    assert.deepEqual(
      decision.actions.map((action) => action.id),
      ['signal-written', 'question-closed', 'abort'],
    );

    // An unreadable pane or session is not an answer.
    open = 'unreadable';
    for (let i = 0; i < 200 && unreadableProbes < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(unreadableProbes >= 3);
    assert.equal(getRun(f.run.id)!.decisions[0]?.resolvedAt, undefined);

    open = false;
    for (let i = 0; i < 200 && !getRun(f.run.id)!.decisions[0]?.resolvedAt; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const resolved = getRun(f.run.id)!.decisions.find((entry) => entry.id === decision.id)!;
    assert.equal(resolved.resolvedAction, 'question-closed');
    assert.equal(getRun(f.run.id)!.status, 'monitoring');
    f.controller.abort();
    await execution;
  },
);

test(
  'after a restart the re-armed handoff resolves question-closed once the question closes',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t);
    const decision = {
      id: `question-${randomUUID()}`,
      type: 'monitor_interactive_handoff' as const,
      title: 'Worker question',
      description: 'The worker asked a question and is waiting for an answer.',
      actions: [
        { id: 'signal-written', label: 'Check SIGNAL.json & resume', style: 'primary' as const },
        { id: 'question-closed', label: 'Resume monitoring', style: 'primary' as const },
        { id: 'abort', label: 'Abort Run', style: 'danger' as const },
      ],
      createdAt: new Date().toISOString(),
      context: { signalFile: null, workerQuestion: true },
    };
    updateRun(f.run.id, { status: 'blocked', decisions: [decision] });
    let open = true;
    const resolved: string[] = [];
    const disarm = rearmInteractiveHandoffAutoRecovery(
      getRun(f.run.id)!,
      async (_runId, _decisionId, actionId) => {
        resolved.push(actionId);
      },
      { question: async () => (open ? 'Detach?' : null), pollMs: 5 },
    );
    t.after(() => disarm?.());
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(resolved, [], 'an open question keeps the handoff');
    open = false;
    for (let i = 0; i < 200 && !resolved.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(resolved, ['question-closed']);
  },
);
