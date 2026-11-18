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

import type { MonitorViolation, WorkerSignal } from '@farmslot/protocol';

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
  persistMonitorWindowStart,
  resolveMonitorDecision,
} from './run-monitor.js';
import { deleteTestRunIfPresent } from './test-fixtures.js';

const RUNNER_FAILURE = 'Pi model request timed out after 300000ms and one retry';

const signal = (status: WorkerSignal['status']): WorkerSignal => ({
  status,
  attemptId: 'owned-attempt',
  role: 'dev',
  contextId: 'dev',
  timestamp: new Date().toISOString(),
  ...(status === 'blocked' ? { reason: 'Needs a product decision' } : {}),
});

/**
 * A live pi worker whose last turn ended on a runner failure, on a run with a
 * 3 s monitoring window that starts now and no structured activity for 10 s
 * against a 0.5 s stuck window.
 *
 * The window is deliberately shorter than the time the operator spends on the
 * card, so whether it expires depends on the accounting and not on how fast the
 * monitor starts: charged to the worker, a 2 s answer ends a 1.5 s window; not
 * charged, the window still has most of its 1.5 s left.
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
        total_timeout_min: 1.5 / 60,
        stuck_timeout_min: 0.5 / 60,
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
  await writeFile(path.join(taskDir, 'TASK.md'), '# Worker\n');
  await writeFile(signalFile, JSON.stringify(signal('running')));
  const launchedAt = new Date(Date.now() - 600_000).toISOString();
  updateRun(run.id, {
    status: 'monitoring',
    slotId,
    taskFile: path.join(taskDir, 'TASK.md'),
    agentContexts: [
      {
        // The canonical context id for the dev role; a non-canonical pair is
        // refused by resolveAgentTarget, which production never produces.
        id: 'dev',
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
      startedAt: new Date().toISOString(),
      lastPollAt: new Date().toISOString(),
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
  // What reached the pane. The real send goes through tmux, which this isolated
  // suite refuses, so delivery is injected and recorded instead.
  const delivered: {
    message: string;
    key: string;
    channel: string;
    role?: string;
    contextId?: string;
  }[] = [];
  /** Drop the seeded monitor state, as a run whose first poll has not persisted yet. */
  const clearMonitorState = () => updateRun(run.id, { monitorState: undefined });
  const start = (overrides: Partial<MonitorObservations> = {}) => {
    const observations: MonitorObservations = {
      workerStatus: (slot, runner, runId, role, contextId) =>
        checkAgentLive(slot, runner, runId, role, contextId, pane),
      violations: async () => [],
      deliverResume: async (_runId, _slot, instruction, role, contextId) => {
        delivered.push({ ...instruction, message: instruction.text, role, contextId });
        return 'confirmed';
      },
    };
    const execution = monitorRun(run.id, slotId, controller.signal, {
      ...observations,
      ...overrides,
    });
    executions.push(execution);
    return execution;
  };
  const card = () => getRun(run.id)?.decisions.find((decision) => !decision.resolvedAt);
  const restoreRunner = () => {
    paneFailure = undefined;
  };
  return { run, slotId, start, card, restoreRunner, clearMonitorState, delivered, signalFile };
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
    f.restoreRunner();
    await writeFile(f.signalFile, JSON.stringify(signal('blocked')));
    const result = await execution;

    assert.equal(
      f.delivered.length,
      1,
      'Continue sent nothing to the idle pane: the worker stays stopped and the next poll re-blocks it (5424deb9)',
    );
    assert.match(f.delivered[0]!.message, /runner is available again/i);
    assert.equal(f.delivered[0]!.contextId, 'dev', 'the resume goes to the worker that stopped');
    assert.ok(
      result.snapshots.some((snapshot) => snapshot.trigger === 'nudge'),
      'a delivery the run does not record is invisible to anyone reading it afterwards',
    );
    // A provider outage the operator fixed is not the worker stalling, so the
    // resume must not spend the stuck/idle escalation budget.
    assert.equal(
      getRun(f.run.id)?.metrics.nudgeCount ?? 0,
      nudgesBefore,
      'a resume that burns a nudge brings max_nudges forward every time a provider blips',
    );
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

    // The operator spends longer on the card than the whole 1.5 s window, then
    // fixes the provider and clicks Continue. Moved on the clock rather than
    // slept: a fixed wall-clock wait is a 2 s tax on every CI run and the only
    // thing it proves is that time passes. Only Date is faked, so the monitor's
    // own polling still runs on real timers.
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.setTime(Date.now() + 2_500);
    f.restoreRunner();
    resolveMonitorDecision(unavailable, 'continue');

    // The handoff/timeout card is the one 5424deb9 got 11 s after Continue.
    const timedOut = () =>
      getRun(f.run.id)?.decisions.find(
        (decision) =>
          !decision.resolvedAt &&
          (decision.type === 'monitor_interactive_handoff' || decision.type === 'monitor_timeout'),
      );
    // Charged to the worker, the very next poll ends the window, which is the
    // 11-second re-block. Credited, the window still has most of its 1.5 s, so
    // this watches only long enough to catch a premature card — a window that
    // later expires on its own is the monitor working.
    await until(() => timedOut() !== undefined, 200);

    // The accounting itself, so the case does not rest on wall-clock margins:
    // the wait is recorded as the monitor's own, not the worker's idleness.
    assert.ok(
      (getRun(f.run.id)?.monitorState?.gateWaitMs ?? 0) >= 2_000,
      `the time on the card was not recorded as gate wait: gateWaitMs=${getRun(f.run.id)?.monitorState?.gateWaitMs}`,
    );
    const blocked = timedOut();
    assert.equal(
      blocked,
      undefined,
      `the run was re-blocked as ${blocked?.type} (${JSON.stringify(blocked?.description)}) right after Continue: the seconds spent waiting for the operator were charged to the worker's monitoring window`,
    );
    // Teardown ends the monitor (abort + resolve any open card + await). Waiting
    // for it here instead would time the 1.5 s window expiring on its own, which
    // this case has already finished asserting about.
    void execution;
  },
);

// A card the operator spends 25 minutes on leaves the worker idle for 25
// minutes, and that idleness is the engine's, not the worker's. Without moving
// the inactivity start, the first poll after Continue sees a fully elapsed stuck
// window and can spend a nudge — or open a max_nudges card — in the same
// iteration as the answer.
test(
  'answering a card restarts the inactivity window, not just the timeout window',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const execution = f.start();
    await until(() => f.card() !== undefined);
    const unavailable = f.card()!.id;
    const staleProgressAt = Date.parse(
      getRun(f.run.id)?.monitorState?.lastStructuredProgressAt ?? new Date().toISOString(),
    );

    // No wait needed: the fixture already stamps the worker's last progress 10 s
    // in the past, which is the comparison this case makes.
    f.restoreRunner();
    resolveMonitorDecision(unavailable, 'continue');
    await until(() => (getRun(f.run.id)?.monitorState?.operatorResumedAt ?? '') !== '');

    const resumedAt = Date.parse(getRun(f.run.id)?.monitorState?.operatorResumedAt ?? '');
    assert.ok(
      Number.isFinite(resumedAt),
      'the answer must be recorded as an operator resume, which is what inactivityStartMs reads',
    );
    assert.ok(
      resumedAt > staleProgressAt,
      `the inactivity window still starts at the worker's last progress (${resumedAt} <= ${staleProgressAt}), so a long card spends a nudge on the next poll`,
    );
    void execution;
  },
);

// A restart while an operator is still reading a card used to lose that slice:
// gateWaitMs is only written once a wait finishes, so the recovered loop charged
// the downtime to the worker and could re-raise the timeout being answered.
test(
  'a card still open at restart has its wait credited when the monitor comes back',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    // A card opens inside a window that is already running, so the window start
    // has to predate the marker: the credit is capped at the window's own
    // elapsed time, which is what stops a backwards clock step from driving the
    // timeout check negative.
    const before = getRun(f.run.id)!.monitorState!;
    const interrupted = new Date(Date.now() - 5_000).toISOString();
    updateRun(f.run.id, {
      monitorState: {
        ...before,
        startedAt: new Date(Date.now() - 30_000).toISOString(),
        gateWaitStartedAt: interrupted,
      },
    });
    // The provider is already restored, so the recovered loop polls normally
    // instead of blocking on a fresh card before it can persist anything.
    f.restoreRunner();

    const execution = f.start();
    await until(() => (getRun(f.run.id)?.monitorState?.gateWaitMs ?? 0) >= 5_000);

    assert.ok(
      (getRun(f.run.id)?.monitorState?.gateWaitMs ?? 0) >= 5_000,
      `the interrupted card's wait was not credited: gateWaitMs=${getRun(f.run.id)?.monitorState?.gateWaitMs}`,
    );
    // The recovered loop may already be on a card of its own (this window is
    // deliberately spent), so what matters is that the interrupted marker is
    // gone rather than that no marker exists: crediting it twice is the bug.
    assert.notEqual(
      getRun(f.run.id)?.monitorState?.gateWaitStartedAt,
      interrupted,
      'the interrupted marker must not survive, or every later restart counts the same wait again',
    );
    void execution;
  },
);

// A max-nudges card is the opposite case: the worker is already stuck, Continue
// means "resume nudging", and handing it a fresh stuck window would silence both
// the next nudge and the timeout card for another full window.
test(
  'answering a max_nudges card does not restart the inactivity window',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    // No runner failure: the stuck violation is what raises a card here.
    f.restoreRunner();
    const stuck: MonitorViolation = {
      slotId: f.slotId,
      role: 'dev',
      contextId: 'dev',
      type: 'stuck',
      message: 'No structured runner activity for 21 minutes',
      nudgeSent: null,
      timestamp: new Date().toISOString(),
    };
    const execution = f.start({ violations: async () => [stuck] });
    await until(() => f.card() !== undefined);
    assert.equal(f.card()?.type, 'monitor_max_nudges');

    // The grace, if granted, is written by the poll persist that follows the
    // answer, so the case has to see that persist land or it asserts nothing.
    const polledAt = getRun(f.run.id)?.monitorState?.lastPollAt;
    resolveMonitorDecision(f.card()!.id, 'continue');
    await until(() => getRun(f.run.id)?.monitorState?.lastPollAt !== polledAt);

    assert.equal(
      getRun(f.run.id)?.monitorState?.operatorResumedAt,
      undefined,
      'a stuck worker must not be granted inactivity grace by the card raised about it being stuck',
    );
    void execution;
  },
);

// The cap itself. A marker older than the window start cannot happen while one
// process owns both writes, but a clock stepped backwards between them can
// produce it, and an uncapped credit then drives the timeout check negative —
// a run that never times out at all.
test(
  'a card marker older than the window start credits only the window',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    f.restoreRunner();
    const before = getRun(f.run.id)!.monitorState!;
    updateRun(f.run.id, {
      monitorState: {
        ...before,
        startedAt: new Date(Date.now() - 2_000).toISOString(),
        // Two minutes of "wait" against a two-second window.
        gateWaitStartedAt: new Date(Date.now() - 120_000).toISOString(),
      },
    });

    const execution = f.start();
    await until(() => (getRun(f.run.id)?.monitorState?.gateWaitMs ?? 0) > 0);

    const credited = getRun(f.run.id)?.monitorState?.gateWaitMs ?? 0;
    assert.ok(
      credited <= 10_000,
      `the credit was not capped at the window: gateWaitMs=${credited} for a 2 s window, so elapsed goes negative and the run stops timing out`,
    );
    void execution;
  },
);

// Codex r1 on #2322: clearing the marker and storing the credit were two
// writes, and only the marker write happened when the card was answered — the
// total waited for the next poll's persist. A restart in between (a resume
// delivery that hangs, a second card) dropped the credit the marker existed to
// protect. Both now land in one durable write, so a recovered monitor sees
// either the marker or a total that already includes it.
test(
  'answering a card stores the credit in the same write that drops the marker',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const execution = f.start();
    await until(() => f.card() !== undefined);
    const unavailable = f.card()!.id;
    await until(() => getRun(f.run.id)?.monitorState?.gateWaitStartedAt !== undefined, 1_000);

    assert.ok(
      getRun(f.run.id)?.monitorState?.gateWaitStartedAt,
      'the open-card marker must be recorded before the monitor blocks on the card',
    );
    f.restoreRunner();
    resolveMonitorDecision(unavailable, 'continue');
    await until(() => getRun(f.run.id)?.monitorState?.gateWaitStartedAt === undefined);

    const settled = getRun(f.run.id)?.monitorState;
    assert.equal(settled?.gateWaitStartedAt, undefined, 'the marker is dropped on the answer');
    assert.ok(
      (settled?.gateWaitMs ?? 0) > 0,
      `the credit must already be stored when the marker goes, or a restart here loses it: gateWaitMs=${settled?.gateWaitMs}`,
    );
    void execution;
  },
);

// Codex r1, second half of FSR-04: the persistence helpers returned early when
// a run had no monitorState yet, and every existing fixture seeds it. A card
// raised before the first poll persists — a runner failure on the first
// observation, which is this run's own shape — left the wait unmarked, so a
// restart during it charged the whole card to the worker.
test(
  'a card raised before the first poll persist still records its wait',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    f.clearMonitorState();
    assert.equal(getRun(f.run.id)?.monitorState, undefined, 'the run starts with no monitor state');

    const execution = f.start();
    await until(() => f.card() !== undefined);
    await until(() => getRun(f.run.id)?.monitorState?.gateWaitStartedAt !== undefined, 1_000);

    assert.ok(
      getRun(f.run.id)?.monitorState?.gateWaitStartedAt,
      'an unmarked card means a restart during it charges the operator wait to the worker',
    );
    void execution;
  },
);

// Codex r1, third part of FSR-04: settlement was not bound to the marker it
// owned. A replayed monitor raises its own card while the previous loop is
// still unwinding its `finally`; that loop then cleared the replacement's
// marker, so a restart during the second card charged its whole wait to the
// worker — the first defect again, one card along.
test(
  'answering a card leaves a replacement monitor’s open marker alone',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const execution = f.start();
    await until(() => f.card() !== undefined);
    const unavailable = f.card()!.id;
    await until(() => getRun(f.run.id)?.monitorState?.gateWaitStartedAt !== undefined, 1_000);

    // A newer wait's marker, as a replayed monitor would have written it.
    const replacementMarker = new Date(Date.now() + 1_000).toISOString();
    const held = getRun(f.run.id)!.monitorState!;
    updateRun(f.run.id, { monitorState: { ...held, gateWaitStartedAt: replacementMarker } });

    f.restoreRunner();
    resolveMonitorDecision(unavailable, 'continue');
    await until(() => (getRun(f.run.id)?.monitorState?.gateWaitMs ?? 0) > 0);

    const settled = getRun(f.run.id)?.monitorState;
    assert.equal(
      settled?.gateWaitStartedAt,
      replacementMarker,
      'a settling wait must not drop a marker it did not write; the newer card still needs it',
    );
    assert.ok(
      (settled?.gateWaitMs ?? 0) > 0,
      `the answered wait's own credit is still stored: gateWaitMs=${settled?.gateWaitMs}`,
    );
    void execution;
  },
);

// Grok r1 on #2322: the ownership check in commitGateWait is a same-tick guard,
// and the retiring loop polls again right after. That poll builds a fresh
// monitorState literal with no gateWaitStartedAt, so it dropped the replacement
// monitor's marker one poll after commitGateWait preserved it — the same lost
// restart credit, moved by 5 ms.
test(
  'a poll by a retiring monitor keeps a replacement wait’s open marker',
  { timeout: 15_000 },
  async (t) => {
    const f = await fixture(t);
    const execution = f.start();
    await until(() => f.card() !== undefined);
    const unavailable = f.card()!.id;
    await until(() => getRun(f.run.id)?.monitorState?.gateWaitStartedAt !== undefined, 1_000);

    const replacementMarker = new Date(Date.now() + 1_000).toISOString();
    const held = getRun(f.run.id)!.monitorState!;
    updateRun(f.run.id, { monitorState: { ...held, gateWaitStartedAt: replacementMarker } });

    f.restoreRunner();
    resolveMonitorDecision(unavailable, 'continue');
    // Wait for the loop to poll again: that write, not the settlement, is what
    // used to erase the marker.
    const polledAt = getRun(f.run.id)?.monitorState?.lastPollAt;
    await until(() => getRun(f.run.id)?.monitorState?.lastPollAt !== polledAt);

    assert.notEqual(
      getRun(f.run.id)?.monitorState?.lastPollAt,
      polledAt,
      'the monitor must poll again for this case to say anything',
    );
    assert.equal(
      getRun(f.run.id)?.monitorState?.gateWaitStartedAt,
      replacementMarker,
      'the poll write must carry an open marker it does not own, or a restart charges that card to the worker',
    );
    void execution;
  },
);

// Grok r1, second half of the same finding: a new monitoring window zeroes the
// credit by design, but it also cleared the marker of a card that is still open.
// The wait does not end because the window turned over; dropping its marker
// there loses it to the next restart.
test('a new monitoring window keeps the marker of a card still open', async (t) => {
  const f = await fixture(t);
  const openedAt = new Date(Date.now() - 30_000).toISOString();
  updateRun(f.run.id, {
    monitorState: {
      nudgeCount: 0,
      lastPollAt: openedAt,
      startedAt: openedAt,
      gateWaitMs: 4_000,
      gateWaitStartedAt: openedAt,
    },
  });

  persistMonitorWindowStart(f.run.id);

  const state = getRun(f.run.id)?.monitorState;
  assert.equal(state?.gateWaitMs, 0, 'a new window starts with no credit carried into it');
  assert.equal(
    state?.gateWaitStartedAt,
    openedAt,
    'the card is still open; its marker is what credits the wait after a restart',
  );
});
