import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { Events, type Run, type WorkerSignal } from '@farmslot/protocol';

import { claimSlotStatusIf, statusFile } from '../../core/state.js';
import { cleanupSlotAfterRunFailure } from '../../run-engine/orchestrator.js';
import { isWorkerSignalFreshForRun } from '../../run-engine/run-monitor.js';
import {
  beginTerminalTeardown,
  endTerminalTeardown,
} from '../../run-engine/terminal-teardown-registry.js';
import { routeTerminalRunTransition } from '../../run-lifecycle/terminal-transition.js';
import { createRun, deleteRun, getRun, updateRun, updateRunStep } from '../../runs/store.js';
import {
  slotClaimBlockedByHandoff,
  slotClaimBlockedByLiveOwner,
  slotClaimBlockedByRelease,
} from '../dispatch/slot-scoring.js';

import {
  blockedRunWorkerRunningAgain,
  type BlockedWorkerContinuedDependencies,
  freshBlockedMonitorAttempt,
  rebindReleasedSlot,
  resumeBlockedRunWhoseWorkerContinued,
} from './replay-step.js';

const blocked = {
  status: 'blocked',
  attemptId: 'a1',
  step: 'Run recipes',
  timestamp: '2026-10-09T02:43:00Z',
};
const runningAgain = {
  status: 'running',
  attemptId: 'a1',
  step: 'Publish evidence',
  timestamp: '2026-10-09T13:10:00Z',
} as const;

function probeOf(signal: Record<string, unknown>) {
  return {
    ok: false,
    code: signal.status === 'running' ? 'non_terminal' : 'ready',
    message: '',
    signal: signal as unknown as WorkerSignal,
  } as const;
}

const blockedSteps = [
  { name: 'monitor', status: 'done', outputs: { workerSignal: blocked } },
] as Run['steps'];

/** Replace one row of this test file's own fleet status file. */
async function setSlotRow(row: Record<string, unknown>): Promise<void> {
  const fleet = JSON.parse(await readFile(statusFile, 'utf8').catch(() => '{"slots":[]}'));
  const slots = (fleet.slots as Record<string, unknown>[]).filter((s) => s.slot !== row.slot);
  await writeFile(statusFile, JSON.stringify({ ...fleet, slots: [...slots, row] }));
}

/** What a fleet refresh writes for a blocked run's slot: held, owned by the run. */
const heldBy = (slot: string, runId: string) => ({
  slot,
  current_run_id: runId,
  handoff_run_id: null,
  slot_epoch: 1,
  lifecycle: 'held',
  phase: 'pr-watch',
});

async function blockedRun(t: test.TestContext, ticket: string): Promise<Run> {
  const run = createRun({ flowType: 'dev', project: 'example', ticketOrPr: ticket });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const slotId = `slot-${ticket}`;
  await setSlotRow(heldBy(slotId, run.id));
  updateRun(run.id, { status: 'blocked', slotId });
  updateRunStep(run.id, 'dispatch', { status: 'done', outputs: { acknowledgement: 'tmux' } });
  return updateRunStep(run.id, 'monitor', { status: 'done', outputs: { workerSignal: blocked } });
}

/**
 * Deps that read `signal` through the real detection and record each replay.
 * `refusals` replays throw first, as runReplayStep does for stale proof leases.
 */
function recordingDeps(signal: Record<string, unknown>, refusals = 0) {
  const replayed: string[] = [];
  const deps: BlockedWorkerContinuedDependencies = {
    runningWorkerSignal: async (run) => blockedRunWorkerRunningAgain(run, probeOf(signal), null),
    replayMonitor: async (runId) => {
      // Let concurrent notifications pile up behind this one.
      await new Promise((resolve) => setImmediate(resolve));
      if (refusals-- > 0) throw new Error('Proof resources are not healthy after the block.');
      replayed.push(runId);
      updateRunStep(runId, 'monitor', { status: 'running', outputs: undefined });
      return updateRun(runId, { status: 'monitoring' });
    },
  };
  return { replayed, deps };
}

function resumes(runId: string): Record<string, unknown>[] {
  const dispatch = getRun(runId)!.steps.find((step) => step.name === 'dispatch')!;
  const list = (dispatch.outputs?.workerResumedAfterBlocked ?? []) as Record<string, unknown>[];
  return list.map(({ at: _at, ...rest }) => rest);
}

test('a blocked run counts as working again on its own later running signal', () => {
  const run = { status: 'blocked' as const, steps: blockedSteps };
  const detect = (signal: Record<string, unknown>) =>
    blockedRunWorkerRunningAgain(run, probeOf(signal), null);

  assert.deepEqual(detect(runningAgain), runningAgain);
  // A fresh `./mark start` attempt, as the template asks.
  assert.deepEqual(detect({ ...runningAgain, attemptId: 'a2' }), {
    ...runningAgain,
    attemptId: 'a2',
  });
  // No activity after the block, a finished worker (run resume's case), still blocked.
  assert.equal(detect({ ...runningAgain, timestamp: blocked.timestamp }), null);
  assert.equal(detect({ ...runningAgain, status: 'complete' }), null);
  assert.equal(detect(blocked), null);
  assert.equal(
    blockedRunWorkerRunningAgain({ ...run, status: 'monitoring' }, probeOf(runningAgain), null),
    null,
  );
});

test('the monitor checks accept the blocked attempt running again, with no SIGNAL.json rewrite', () => {
  const run = { status: 'blocked' as const, steps: blockedSteps };
  // Operator replay and run resume still ask for ./mark start; the automatic replay does not.
  assert.equal(freshBlockedMonitorAttempt(run, probeOf(runningAgain), null), null);
  assert.deepEqual(
    freshBlockedMonitorAttempt(run, probeOf(runningAgain), null, {
      acceptRunningBlockedAttempt: true,
    }),
    runningAgain,
  );
  // After the replay binds the context to that attempt, the monitor reads its signals as live.
  const replayed = {
    status: 'monitoring',
    steps: [{ name: 'monitor', status: 'running' }],
    agentContexts: [{ id: 'worker', role: 'primary', signalAttemptId: 'a1' }],
  } as unknown as Run;
  assert.equal(isWorkerSignalFreshForRun(replayed, runningAgain), true);
  assert.equal(isWorkerSignalFreshForRun(replayed, { ...runningAgain, status: 'complete' }), true);
});

test('a blocked run whose worker kept going on the same attempt replays the monitor and records it once', async (t) => {
  const run = await blockedRun(t, 'PROJ-RESUMED');
  const { replayed, deps } = recordingDeps(runningAgain);
  const emitted: string[] = [];
  const emit = (event: string) => emitted.push(event);

  const resumed = await resumeBlockedRunWhoseWorkerContinued(run.id, emit, deps);
  assert.equal(resumed?.status, 'monitoring');
  assert.deepEqual(replayed, [run.id]);
  assert.deepEqual(emitted, [Events.RUN_UPDATED]);
  assert.equal(
    getRun(run.id)!.steps.find((s) => s.name === 'dispatch')!.outputs?.acknowledgement,
    'tmux',
  );
  assert.deepEqual(resumes(run.id), [
    { blockedAttemptId: 'a1', attemptId: 'a1', step: 'Publish evidence' },
  ]);

  // The next signal the watcher sees finds the run monitoring: nothing more.
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, emit, deps), null);
  assert.deepEqual(replayed, [run.id]);
  assert.equal(emitted.length, 1);
});

test('a worker that ran ./mark start after the block resumes the same way', async (t) => {
  const run = await blockedRun(t, 'PROJ-MARK-START');
  const { replayed, deps } = recordingDeps({ ...runningAgain, attemptId: 'a2', step: 'started' });
  assert.equal(
    (await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps))?.status,
    'monitoring',
  );
  assert.deepEqual(replayed, [run.id]);
  assert.deepEqual(resumes(run.id), [{ blockedAttemptId: 'a1', attemptId: 'a2', step: 'started' }]);
});

test('twenty simultaneous running notifications replay the monitor once', async (t) => {
  const run = await blockedRun(t, 'PROJ-BURST');
  const { replayed, deps } = recordingDeps(runningAgain);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps)),
  );
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(replayed, [run.id]);
  assert.equal(resumes(run.id).length, 1);
});

test('a refused replay records nothing, and the next running signal retries', async (t) => {
  const run = await blockedRun(t, 'PROJ-REFUSED');
  const { replayed, deps } = recordingDeps(runningAgain, 1);

  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps), null);
  assert.equal(getRun(run.id)!.status, 'blocked');
  assert.deepEqual(resumes(run.id), []);

  assert.equal(
    (await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps))?.status,
    'monitoring',
  );
  assert.deepEqual(replayed, [run.id]);
  assert.equal(resumes(run.id).length, 1);
});

test('a blocked run with no worker activity after the block stays blocked', async (t) => {
  const run = await blockedRun(t, 'PROJ-QUIET');
  const { replayed, deps } = recordingDeps({ ...runningAgain, timestamp: blocked.timestamp });
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps), null);
  assert.deepEqual(replayed, []);
  assert.equal(getRun(run.id)!.status, 'blocked');
});

test('a worker that finished after the block is left to run resume', async (t) => {
  const run = await blockedRun(t, 'PROJ-FINISHED');
  const { replayed, deps } = recordingDeps({ ...runningAgain, status: 'complete' });
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps), null);
  assert.deepEqual(replayed, []);
});

test('cancelled and eval runs are left alone, even when the worker kept going', async (t) => {
  const cancelled = await blockedRun(t, 'PROJ-CANCELLED');
  updateRun(cancelled.id, { status: 'cancelled' });
  const evalRun = await blockedRun(t, 'PROJ-EVAL');
  updateRun(evalRun.id, {
    engineState: {
      ...evalRun.engineState,
      evalExperiment: { experimentId: 'exp-1' },
    } as unknown as Run['engineState'],
  });
  const { replayed, deps } = recordingDeps(runningAgain);
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(cancelled.id, () => {}, deps), null);
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(evalRun.id, () => {}, deps), null);
  assert.deepEqual(replayed, []);
  assert.equal(getRun(evalRun.id)!.status, 'blocked');
});

test('a worker that resumes during the block teardown waits for the cleanup, then re-binds its free slot and resumes', async (t) => {
  const slotId = 'slot-terminal-overlap';
  const run = createRun({ flowType: 'dev', project: 'example', ticketOrPr: 'PROJ-OVERLAP' });
  t.after(async () => {
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  updateRun(run.id, { status: 'monitoring', slotId });
  updateRunStep(run.id, 'dispatch', { status: 'done' });
  updateRunStep(run.id, 'monitor', { status: 'done', outputs: { workerSignal: blocked } });
  await writeFile(
    statusFile,
    JSON.stringify({
      slots: [
        {
          slot: slotId,
          current_run_id: run.id,
          handoff_run_id: null,
          slot_epoch: 1,
          lifecycle: 'busy',
          phase: 'working',
        },
      ],
    }),
  );
  const order: string[] = [];
  let release!: () => void;
  const settleGate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const settling = new Promise<void>((resolve) => (entered = resolve));
  // What routeAndRecordTerminalTransition does: the whole transition, publish
  // included, runs inside the slot's teardown bracket.
  beginTerminalTeardown(slotId);
  const terminal = routeTerminalRunTransition({
    runId: run.id,
    kind: 'block',
    actor: 'engine',
    patch: { status: 'blocked' },
    collaborators: {
      emit: () => {},
      settleBacklog: async () => {
        entered();
        await settleGate;
      },
      tickWorkGraph: async () => {},
      cleanupEvalHarness: async () => {},
      cleanupSlot: async (blockedRun) => {
        await cleanupSlotAfterRunFailure(slotId, blockedRun.id, 'monitor-terminal blocked');
        order.push('slot-cleanup');
      },
    },
  }).finally(() => endTerminalTeardown(slotId));
  t.after(async () => {
    release();
    await terminal;
  });
  const { replayed, deps } = recordingDeps(runningAgain);
  const replayMonitor = deps.replayMonitor;
  deps.replayMonitor = async (id) => {
    order.push('replay');
    return replayMonitor(id);
  };

  await settling;
  assert.equal(getRun(run.id)!.status, 'blocked');
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps), null);
  assert.deepEqual(replayed, []);

  release();
  await terminal;
  const released = JSON.parse(await readFile(statusFile, 'utf8')).slots[0];
  assert.equal(released.current_run_id, null, 'the block cleanup released the slot');
  assert.equal(released.lifecycle, 'ready');

  // The worker is still in that workspace: the free slot is re-bound, then resumed.
  assert.equal(
    (await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps))?.status,
    'monitoring',
  );
  assert.deepEqual(order, ['slot-cleanup', 'replay']);
  const rebound = JSON.parse(await readFile(statusFile, 'utf8')).slots[0];
  assert.equal(rebound.current_run_id, run.id);
  assert.equal(rebound.lifecycle, 'held');
  assert.ok(rebound.slot_epoch > released.slot_epoch, 'a claim-type write');

  // The next signal finds the run monitoring: nothing more.
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps), null);
  assert.deepEqual(replayed, [run.id]);
});

test('a blocked run whose released slot another run claimed stays blocked and says so', async (t) => {
  const run = await blockedRun(t, 'PROJ-CLAIMED');
  await setSlotRow({ ...heldBy(run.slotId!, 'other-run'), lifecycle: 'busy', phase: 'working' });
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (line: string) => warnings.push(line));
  const { replayed, deps } = recordingDeps(runningAgain);
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps), null);
  assert.deepEqual(replayed, []);
  assert.equal(getRun(run.id)!.status, 'blocked');
  assert.match(
    warnings.join('\n'),
    /worker resumed .* but slot slot-PROJ-CLAIMED now belongs to run other-run/,
  );
  assert.equal(
    JSON.parse(await readFile(statusFile, 'utf8')).slots.find(
      (s: { slot: string }) => s.slot === run.slotId,
    ).current_run_id,
    'other-run',
  );
});

test('a dispatch claim racing the re-bind of a released slot: exactly one wins', async (t) => {
  for (const dispatchFirst of [true, false]) {
    const run = await blockedRun(t, `PROJ-RACE-${dispatchFirst}`);
    const slotId = run.slotId!;
    await setSlotRow({
      slot: slotId,
      current_run_id: null,
      handoff_run_id: null,
      slot_epoch: 3,
      lifecycle: 'ready',
      phase: null,
    });
    // The dispatcher's claim: the same write chain and predicates as find-slot.
    const dispatch = () =>
      claimSlotStatusIf(
        slotId,
        (slot) =>
          slotClaimBlockedByRelease(slot) === null &&
          slotClaimBlockedByHandoff(slot, 'dispatch-run') === null &&
          slotClaimBlockedByLiveOwner(slot, 'dispatch-run', getRun) === null,
        {
          lifecycle: 'busy',
          phase: 'preparing',
          current_run_id: 'dispatch-run',
          handoff_run_id: null,
        },
      );
    const [first, second] = dispatchFirst
      ? await Promise.all([dispatch(), rebindReleasedSlot(run)])
      : (await Promise.all([rebindReleasedSlot(run), dispatch()])).reverse();
    const claimed = (first as { claimed: boolean }).claimed;
    const rebound = second === null;
    assert.equal(Number(claimed) + Number(rebound), 1, `dispatchFirst=${dispatchFirst}`);
    assert.equal(claimed, dispatchFirst);
    const row = JSON.parse(await readFile(statusFile, 'utf8')).slots.find(
      (s: { slot: string }) => s.slot === slotId,
    );
    assert.equal(row.current_run_id, dispatchFirst ? 'dispatch-run' : run.id);
    if (dispatchFirst) assert.equal(second, 'run dispatch-run');
  }
});
