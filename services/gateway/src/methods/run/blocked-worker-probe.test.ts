import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { RunProbeWorkerSignalResult, WorkerSignal } from '@farmslot/protocol';

import * as realMonitor from '../../run-engine/run-monitor.js';
import { createRun, deleteRun, getRun, updateRun, updateRunStep } from '../../runs/store.js';

const signal: WorkerSignal = {
  status: 'running',
  attemptId: 'blocked-attempt',
  timestamp: '2026-10-22T08:00:00Z',
};
const probe: RunProbeWorkerSignalResult = {
  ok: false,
  code: 'non_terminal',
  message: 'Worker resumed its attempt',
  signal,
};
mock.module('../../run-engine/run-monitor.js', {
  namedExports: { ...realMonitor, probeWorkerSignalForRun: async () => probe },
});
const { blockedRunResumableSignal } = await import('./replay-step.js');
const { runResumeTransitionLocked } = await import('./lifecycle-control.js');

test('probe and Resume agree after a primary blocked attempt continues without mark start', async (t) => {
  const run = createRun({ project: 'example', flowType: 'dev', ticketOrPr: 'PROJ-RESUME' });
  t.after(async () => {
    if (!getRun(run.id)) return;
    updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  updateRunStep(run.id, 'monitor', {
    status: 'done',
    outputs: {
      workerSignal: { ...signal, status: 'blocked', timestamp: '2026-10-22T07:40:00Z' },
    },
  });
  const blocked = updateRun(run.id, { status: 'blocked' })!;
  // Automatic recovery can be refused by unhealthy proof resources. Once they
  // recover, an operator refresh must not offer a replay its attempt guard refuses.
  const check = await blockedRunResumableSignal(blocked);
  assert.equal(check.signal, null, 'the existing primary-attempt safeguard still applies');
  let replays = 0;
  await assert.rejects(
    runResumeTransitionLocked(
      { runId: run.id },
      () => {},
      {},
      {
        nudgeMonitor: async () => assert.fail('must not nudge'),
        redrive: async () => assert.fail('must not redrive'),
        replayGate: async () => assert.fail('must not replay a gate'),
        blockedRunResumableSignal,
        replayMonitor: async () => {
          replays++;
          return getRun(run.id)!;
        },
      },
    ),
    /is not paused.*status=blocked/s,
  );
  assert.equal(replays, 0);
  assert.equal(getRun(run.id)?.status, 'blocked');
});
