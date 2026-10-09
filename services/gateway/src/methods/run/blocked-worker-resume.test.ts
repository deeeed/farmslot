import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Events, type Run, type WorkerSignal } from '@farmslot/protocol';

import { replaceSignalIfUnchangedCommand } from '../../run-engine/run-monitor.js';
import { createRun, deleteRun, getRun, updateRun, updateRunStep } from '../../runs/store.js';

import {
  blockedAttemptRunningAgain,
  type BlockedWorkerContinuedDependencies,
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

function blockedRun(t: test.TestContext, ticket: string): Run {
  const run = createRun({ flowType: 'dev', project: 'example', ticketOrPr: ticket });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  updateRun(run.id, { status: 'blocked', slotId: 'slot-1' });
  updateRunStep(run.id, 'dispatch', { status: 'done', outputs: { acknowledgement: 'tmux' } });
  return updateRunStep(run.id, 'monitor', { status: 'done', outputs: { workerSignal: blocked } });
}

/** Deps that read `signal` through the real detection and record every call. */
function recordingDeps(signal: Record<string, unknown>) {
  const calls = { rotated: [] as string[], replayed: [] as string[] };
  const deps: BlockedWorkerContinuedDependencies = {
    runningBlockedAttempt: async (run) => blockedAttemptRunningAgain(run, probeOf(signal), null),
    rotateAttempt: async (_run, rotated) => {
      calls.rotated.push(rotated.attemptId!);
      return 'a2';
    },
    // What runReplayStep leaves: the monitor running again.
    replayMonitor: async (runId) => {
      calls.replayed.push(runId);
      updateRunStep(runId, 'monitor', { status: 'running', outputs: undefined });
      return updateRun(runId, { status: 'monitoring' });
    },
  };
  return { calls, deps };
}

test('a blocked attempt is running again only when its own later signal says running', () => {
  const run = {
    status: 'blocked' as const,
    steps: [
      { name: 'monitor', status: 'done', outputs: { workerSignal: blocked } },
    ] as Run['steps'],
  };
  const detect = (signal: Record<string, unknown>) =>
    blockedAttemptRunningAgain(run, probeOf(signal), null);

  assert.deepEqual(detect(runningAgain), runningAgain);
  // No activity after the block, another attempt, or a finished one (run resume's case).
  assert.equal(detect({ ...runningAgain, timestamp: blocked.timestamp }), null);
  assert.equal(detect({ ...runningAgain, attemptId: 'a2' }), null);
  assert.equal(detect({ ...runningAgain, status: 'complete' }), null);
  assert.equal(detect(blocked), null);
  assert.equal(
    blockedAttemptRunningAgain({ ...run, status: 'monitoring' }, probeOf(runningAgain), null),
    null,
  );
});

test('a blocked run whose worker kept going rotates the attempt, replays the monitor and records it once', async (t) => {
  const run = blockedRun(t, 'PROJ-RESUMED');
  const { calls, deps } = recordingDeps(runningAgain);
  const emitted: string[] = [];
  const emit = (event: string) => emitted.push(event);

  const resumed = await resumeBlockedRunWhoseWorkerContinued(run.id, emit, deps);
  assert.equal(resumed?.status, 'monitoring');
  assert.deepEqual(calls, { rotated: ['a1'], replayed: [run.id] });
  assert.deepEqual(emitted, [Events.RUN_UPDATED]);
  const dispatch = getRun(run.id)!.steps.find((step) => step.name === 'dispatch')!;
  assert.equal(dispatch.outputs?.acknowledgement, 'tmux');
  const [event, ...more] = dispatch.outputs?.workerResumedAfterBlocked as Record<string, unknown>[];
  assert.deepEqual(
    { ...event, at: undefined },
    { fromAttemptId: 'a1', toAttemptId: 'a2', step: 'Publish evidence', at: undefined },
  );
  assert.equal(more.length, 0);

  // The next signal the watcher sees finds the run monitoring: nothing more.
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, emit, deps), null);
  assert.deepEqual(calls, { rotated: ['a1'], replayed: [run.id] });
  assert.equal(emitted.length, 1);
});

test('a blocked run with no worker activity after the block stays blocked', async (t) => {
  const run = blockedRun(t, 'PROJ-QUIET');
  const { calls, deps } = recordingDeps({ ...runningAgain, timestamp: blocked.timestamp });
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps), null);
  assert.deepEqual(calls, { rotated: [], replayed: [] });
  assert.equal(getRun(run.id)!.status, 'blocked');
});

test('a worker that finished after the block is left to run resume', async (t) => {
  const run = blockedRun(t, 'PROJ-FINISHED');
  const { calls, deps } = recordingDeps({ ...runningAgain, status: 'complete' });
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps), null);
  assert.deepEqual(calls, { rotated: [], replayed: [] });
});

test('a cancelled run is left alone, even when its worker kept going', async (t) => {
  const run = blockedRun(t, 'PROJ-CANCELLED');
  updateRun(run.id, { status: 'cancelled' });
  const { calls, deps } = recordingDeps(runningAgain);
  assert.equal(await resumeBlockedRunWhoseWorkerContinued(run.id, () => {}, deps), null);
  assert.deepEqual(calls, { rotated: [], replayed: [] });
});

test('the attempt rotation replaces SIGNAL.json only while it holds the bytes read', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'signal-rotate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "it's SIGNAL.json");
  const observed = `${JSON.stringify(runningAgain, null, 2)}\n`;
  const next = `${JSON.stringify({ ...runningAgain, attemptId: 'a2', note: "100% '$x'" }, null, 2)}\n`;
  const run = (cmd: string) => {
    try {
      execFileSync('sh', ['-c', cmd]);
      return true;
    } catch {
      return false;
    }
  };

  writeFileSync(file, observed);
  assert.equal(run(replaceSignalIfUnchangedCommand(file, observed, next)), true);
  assert.equal(readFileSync(file, 'utf8'), next);

  // The worker marked a step in between: its write wins.
  const marked = `${JSON.stringify({ ...runningAgain, step: 'Later' }, null, 2)}\n`;
  writeFileSync(file, marked);
  assert.equal(run(replaceSignalIfUnchangedCommand(file, observed, next)), false);
  assert.equal(readFileSync(file, 'utf8'), marked);
});
