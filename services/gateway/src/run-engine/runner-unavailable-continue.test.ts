// @farmslot:serial — owns temporary project and pool rows in this checkout.
// Run 5424deb9 (macpro-mm-6): the operator resolved a `runner unavailable`
// decision with Continue at 05:14:16. The idle pi pane was never re-prompted —
// the session file did not change — and 11 s later the monitor blocked the run
// again as "interactive handoff exceeded 90 min".
//
// Two defects, both in the `v.type === 'error'` branch of run-monitor.ts
// (around :1746):
//   1. Continue falls through to `continue` with nothing sent to the worker. The
//      stuck/idle branches call sendNudge; this one delivers nothing, so a
//      worker that stopped mid-turn stays stopped.
//   2. The time the run spent blocked on that decision is not credited. The
//      total-timeout check at step 5 subtracts only state.operatorWaitMs, which
//      is derived from the *worker's* own waitingForOperator signal, never from
//      a gateway decision the operator had to answer. The window therefore
//      keeps running while a human is reading the card.
//
// Same gap as 961987b5, which sat idle after LiteLLM 502 retries.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WorkerSignal } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { farmslotRoot } from '../fleet/state.js';
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

const RUNNER_FAILURE = 'Pi model request timed out after 300000ms and one retry';

const signal = (status: WorkerSignal['status']): WorkerSignal => ({
  status,
  attemptId: 'owned-attempt',
  role: 'dev',
  contextId: 'worker',
  timestamp: new Date().toISOString(),
  ...(status === 'blocked' ? { reason: 'Needs a product decision' } : {}),
});

/**
 * A live pi worker whose last turn ended on a runner failure, on a run whose
 * monitoring window is nearly spent: 2.5 s into a 3 s total timeout, with no
 * structured activity for 10 s against a 1 s stuck window. One more second of
 * uncredited wall time ends the window.
 */
async function fixture(t: test.TestContext) {
  const project = `unavailable-continue-${randomUUID()}`;
  const projectDir = path.join(farmslotRoot(), 'projects', project);
  const poolFile = path.join(farmslotRoot(), 'pool', `${project}.json`);
  const worker = await mkdtemp(path.join(os.tmpdir(), 'unavailable-continue-'));
  const taskDir = path.join(projectDir, 'tasks/dev/fixture');
  const signalFile = path.join(worker, 'SIGNAL.json');
  const slotId = `${project}-slot`;
  const controller = new AbortController();
  const executions: Array<ReturnType<typeof monitorRun>> = [];
  const run = createRun({
    project,
    flowType: 'dev',
    mode: 'autonomous',
    ticketOrPr: 'TAT-4639',
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
      monitoring: {
        poll_interval_min: 1 / 60_000,
        total_timeout_min: 3 / 60,
        stuck_timeout_min: 1 / 60,
        max_nudges: 3,
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
  await writeFile(path.join(taskDir, 'TASK.md'), '# Worker\n');
  await writeFile(signalFile, JSON.stringify(signal('running')));
  const launchedAt = new Date(Date.now() - 600_000).toISOString();
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
        startedAt: launchedAt,
        attemptStartedAt: launchedAt,
      },
    ],
    monitorState: {
      nudgeCount: 0,
      startedAt: new Date(Date.now() - 2_500).toISOString(),
      lastPollAt: new Date(Date.now() - 2_500).toISOString(),
      lastStructuredProgressAt: new Date(Date.now() - 10_000).toISOString(),
    },
  });
  // The provider failure the operator is about to resolve. Once they do, the
  // pane reports a plain idle turn, as a restored runner would.
  let paneFailure: string | undefined = RUNNER_FAILURE;
  const pane = {
    slot: async () => makeVars({ slotId, session: slotId }),
    target: async () => ({ target: `${slotId}:dev`, session: slotId }),
    exec: async () => ({ exitCode: 0, stdout: '42\n', stderr: '' }),
    process: async () => ({ state: 'present' as const, pid: '99' }),
    turn: async (): Promise<ObservabilityReading<RunnerSessionDeliveryState>> => ({
      value: 'idle',
      source: 'hook',
      confidence: 'high',
      observedAt: Date.now(),
      ...(paneFailure ? { failure: paneFailure } : {}),
    }),
  };
  const start = () => {
    const observations: MonitorObservations = {
      workerStatus: (slot, runner, runId, role, contextId) =>
        checkAgentLive(slot, runner, runId, role, contextId, pane),
      violations: async () => [],
    };
    const execution = monitorRun(run.id, slotId, controller.signal, observations);
    executions.push(execution);
    return execution;
  };
  const card = () => getRun(run.id)?.decisions.find((decision) => !decision.resolvedAt);
  const restoreRunner = () => {
    paneFailure = undefined;
  };
  return { run, slotId, start, card, restoreRunner, signalFile };
}

/** Polls for a condition with a short ceiling; never a fixed wait. */
async function until(done: () => boolean, ceilingMs = 2_000): Promise<void> {
  for (let i = 0; i < ceilingMs / 5 && !done(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
}

// The operator answered the card the engine raised. Answering it has to reach
// the worker, or the run is back where it started with one fewer reason to look.
test(
  'Continue on a runner_unavailable card delivers a resume to the worker',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const execution = f.start();
    await until(() => f.card() !== undefined);
    assert.equal(f.card()?.type, 'monitor_runner_unavailable');

    const nudgesBefore = getRun(f.run.id)?.metrics.nudgeCount ?? 0;
    resolveMonitorDecision(f.card()!.id, 'continue');
    await until(() => (getRun(f.run.id)?.metrics.nudgeCount ?? 0) > nudgesBefore);

    assert.ok(
      (getRun(f.run.id)?.metrics.nudgeCount ?? 0) > nudgesBefore,
      'Continue sent nothing to the idle pane: the worker stays stopped and the next poll re-blocks it (5424deb9)',
    );
    await writeFile(f.signalFile, JSON.stringify(signal('blocked')));
    await execution;
  },
);

// A card the operator has to read is the engine's own wait, not the worker's
// idleness. Charging that time to the worker's monitoring window is what turned
// a 58-second answer into "interactive handoff exceeded 90 min" 11 s later.
test(
  'time blocked on a runner_unavailable card is not charged to the monitoring window',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const execution = f.start();
    await until(() => f.card() !== undefined);
    const unavailable = f.card()!.id;

    // The operator spends a second on the card — more than the 0.5 s this
    // window had left of its 3 s — then fixes the provider and clicks Continue.
    await until(() => false, 1_000);
    f.restoreRunner();
    resolveMonitorDecision(unavailable, 'continue');

    // The handoff/timeout card is the one 5424deb9 got 11 s after Continue.
    const timedOut = () =>
      getRun(f.run.id)?.decisions.find(
        (decision) =>
          !decision.resolvedAt &&
          (decision.type === 'monitor_interactive_handoff' || decision.type === 'monitor_timeout'),
      );
    await until(() => timedOut() !== undefined);

    const blocked = timedOut();
    assert.equal(
      blocked,
      undefined,
      `the run was re-blocked as ${blocked?.type} right after Continue: the second spent waiting for the operator was charged to the worker's monitoring window`,
    );
    await writeFile(f.signalFile, JSON.stringify(signal('blocked')));
    await execution;
  },
);
