// @farmslot:serial — owns temporary project and pool rows in this checkout.
// F328 ce1c5583, 2026-11-02: a gateway restart resumed the monitor of a live Pi worker whose
// model stream had just been torn down ("terminated"). The monitor failed the run on that turn
// error, and the failure teardown sent /exit to the worker.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { MonitorViolation, WorkerSignal } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { farmslotRoot } from '../fleet/state.js';
import { continueResolvedRunDecision } from '../methods/run.js';
import type {
  ObservabilityReading,
  RunnerSessionDeliveryState,
} from '../runners/observability-types.js';
import { makeVars } from '../runners/test-fixtures.js';
import { createRun, getRun, updateRun } from '../runs/store.js';

import {
  checkAgentLive,
  type MonitorObservations,
  monitorRun,
  resolveMonitorDecision,
} from './run-monitor.js';
import { deleteTestRunIfPresent } from './test-fixtures.js';

const signal = (status: WorkerSignal['status']): WorkerSignal => ({
  status,
  attemptId: 'owned-attempt',
  role: 'dev',
  contextId: 'worker',
  timestamp: new Date().toISOString(),
  ...(status === 'blocked' ? { reason: 'Needs a product decision' } : {}),
});

/** A recovered monitor of a live Pi worker on a local fixture slot. */
async function fixture(t: test.TestContext, maxNudges = 0) {
  const project = `transport-abort-${randomUUID()}`;
  const projectDir = path.join(farmslotRoot(), 'projects', project);
  const poolFile = path.join(farmslotRoot(), 'pool', `${project}.json`);
  const worker = await mkdtemp(path.join(os.tmpdir(), 'transport-abort-'));
  const taskDir = path.join(projectDir, 'tasks/dev/fixture');
  const signalFile = path.join(worker, 'SIGNAL.json');
  const slotId = `${project}-slot`;
  const controller = new AbortController();
  const executions: Array<ReturnType<typeof monitorRun>> = [];
  const run = createRun({
    project,
    flowType: 'dev',
    mode: 'autonomous',
    ticketOrPr: 'TAT-4355',
    runner: 'pi',
  });
  t.after(async () => {
    controller.abort();
    for (const decision of getRun(run.id)?.decisions ?? [])
      if (!decision.resolvedAt) resolveMonitorDecision(decision.id, 'abort');
    await Promise.allSettled(executions);
    await deleteTestRunIfPresent(run.id);
    await rm(projectDir, { recursive: true, force: true });
    await rm(poolFile, { force: true });
    await rm(worker, { recursive: true, force: true });
  });
  await mkdir(taskDir, { recursive: true });
  await mkdir(path.dirname(poolFile), { recursive: true });
  await writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({
      name: project,
      monitoring: { poll_interval_min: 1 / 60_000, total_timeout_min: 1, max_nudges: maxNudges },
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
  await writeFile(path.join(taskDir, 'TASK.md'), '# Worker\n');
  const startedAt = new Date(Date.now() - 600_000).toISOString();
  await writeFile(signalFile, JSON.stringify(signal('running')));
  updateRun(run.id, {
    status: 'monitoring',
    slotId,
    taskFile: path.join(taskDir, 'TASK.md'),
    agentContexts: [
      {
        id: 'worker',
        role: 'dev',
        label: 'Worker',
        runner: 'pi',
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
    // Restart recovery resumes from the persisted monitor state.
    monitorState: {
      nudgeCount: 0,
      startedAt,
      lastPollAt: startedAt,
      lastStructuredProgressAt: startedAt,
    },
  });
  /** The live Pi pane, whose last turn ended on `failure`. */
  const paneEndedOn = (failure: string, failureKind?: 'transport', observedAt = Date.now()) => ({
    slot: async () => makeVars({ slotId, session: slotId }),
    target: async () => ({ target: `${slotId}:dev`, session: slotId }),
    exec: async () => ({ exitCode: 0, stdout: '42\n', stderr: '' }),
    process: async () => ({ state: 'present' as const, pid: '99' }),
    turn: async (): Promise<ObservabilityReading<RunnerSessionDeliveryState>> => ({
      value: 'idle',
      source: 'hook',
      confidence: 'high',
      observedAt,
      failure,
      ...(failureKind ? { failureKind } : {}),
    }),
  });
  const start = (observations: MonitorObservations) => {
    const execution = monitorRun(run.id, slotId, controller.signal, observations);
    executions.push(execution);
    return execution;
  };
  const writeSignal = (value: WorkerSignal) => writeFile(signalFile, JSON.stringify(value));
  return { run, slotId, paneEndedOn, start, writeSignal };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

test(
  'a recovered monitor keeps watching a worker whose model stream dropped and ends on its signal',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t);
    const pane = f.paneEndedOn('terminated', 'transport');
    let observed = 0;
    const result = await f.start({
      workerStatus: async (slot, runner, runId, role, contextId) => {
        const status = await checkAgentLive(slot, runner, runId, role, contextId, pane);
        // Nudged on, the worker reaches its own outcome.
        if (++observed === 1) await f.writeSignal(signal('blocked'));
        return status;
      },
      violations: async () => [],
    });

    assert.equal(observed, 1);
    assert.equal(result.exitReason, 'worker-done');
    assert.equal(result.workerSignal?.status, 'blocked');
    assert.equal(result.workerSignal?.reason, 'Needs a product decision');
    assert.deepEqual(getRun(f.run.id)?.decisions, []);
  },
);

// #1427: a failure the runner itself reported is prompt and visible, and keeps the worker.
test(
  'a runner-reported failure blocks the monitor on runner_unavailable with the worker kept',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t);
    const pane = f.paneEndedOn('OAuth refresh failed for anthropic: invalid_grant');
    const execution = f.start({
      workerStatus: (slot, runner, runId, role, contextId) =>
        checkAgentLive(slot, runner, runId, role, contextId, pane),
      violations: async () => [],
    });
    const card = () => getRun(f.run.id)?.decisions.find((decision) => !decision.resolvedAt);
    await until(() => card() !== undefined);

    assert.equal(card()?.type, 'monitor_runner_unavailable');
    assert.match(card()?.description ?? '', /^OAuth refresh failed for anthropic: invalid_grant/);
    assert.equal(getRun(f.run.id)?.status, 'blocked');
    assert.equal(getRun(f.run.id)?.slotId, f.slotId, 'the worker keeps its slot');
    resolveMonitorDecision(card()!.id, 'abort');
    assert.equal((await execution).exitReason, 'aborted');
  },
);

// R2: Continue answers that failed turn. Its record stays until the next hook event.
test(
  'Continue on a runner_unavailable card keeps watching instead of asking again',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t);
    const pane = f.paneEndedOn('OAuth refresh failed for anthropic: invalid_grant');
    const execution = f.start({
      workerStatus: (slot, runner, runId, role, contextId) =>
        checkAgentLive(slot, runner, runId, role, contextId, pane),
      violations: async () => [],
    });
    const card = () => getRun(f.run.id)?.decisions.find((decision) => !decision.resolvedAt);
    await until(() => card() !== undefined);
    resolveMonitorDecision(card()!.id, 'continue');
    await until(() => getRun(f.run.id)?.status === 'monitoring');
    await f.writeSignal(signal('blocked'));

    assert.equal((await execution).exitReason, 'worker-done');
    assert.equal(getRun(f.run.id)?.decisions.length, 1);
  },
);

// R3: the cancel fences the run, then the monitor's waiter ends without settling its step.
test(
  'Abort Run on a runner_unavailable card ends the waiting monitor once the run is cancelled',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t);
    const pane = f.paneEndedOn('OAuth refresh failed for anthropic: invalid_grant');
    const execution = f.start({
      workerStatus: (slot, runner, runId, role, contextId) =>
        checkAgentLive(slot, runner, runId, role, contextId, pane),
      violations: async () => [],
    });
    const card = () => getRun(f.run.id)?.decisions.find((decision) => !decision.resolvedAt);
    await until(() => card() !== undefined);
    const decisionId = card()!.id;
    continueResolvedRunDecision(
      { runId: f.run.id, decisionId, actionId: 'abort' },
      () => {},
      {
        cancelRun: async () => {
          updateRun(f.run.id, { status: 'cancelled' });
        },
      },
      getRun(f.run.id)!.engineState?.generation ?? 0,
    );

    assert.equal((await execution).exitReason, 'aborted');
    assert.equal(getRun(f.run.id)?.status, 'cancelled');
  },
);

// R1: the nudges after a transport-abort turn are bounded by max_nudges and a decision.
test(
  'an idle worker after a dropped model connection reaches the max_nudges decision',
  { timeout: 4000 },
  async (t) => {
    const f = await fixture(t, 0);
    const pane = f.paneEndedOn('terminated', 'transport');
    const stuck: MonitorViolation = {
      slotId: f.slotId,
      role: 'dev',
      contextId: 'worker',
      type: 'stuck',
      message: 'No structured runner activity for 21 minutes',
      nudgeSent: null,
      timestamp: new Date().toISOString(),
    };
    const execution = f.start({
      workerStatus: (slot, runner, runId, role, contextId) =>
        checkAgentLive(slot, runner, runId, role, contextId, pane),
      violations: async () => [stuck],
    });
    const card = () => getRun(f.run.id)?.decisions.find((decision) => !decision.resolvedAt);
    await until(() => card() !== undefined);

    assert.equal(card()?.type, 'monitor_max_nudges');
    assert.equal(getRun(f.run.id)?.status, 'blocked');
    resolveMonitorDecision(card()!.id, 'abort');
    assert.equal((await execution).exitReason, 'aborted');
  },
);
