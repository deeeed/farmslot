// F328: a gateway or node restart drops the monitor's node connection mid-watch. The monitor
// only observes, so it watches again from its persisted state, a bounded number of times.
import assert from 'node:assert/strict';
import test from 'node:test';

import '../runtime/mock-pty.test-support.js';

import { NodeTransportUnavailableError } from '../fleet/node-rpc.js';
import { createRun, updateRun } from '../runs/store.js';

import { executeMonitorStep, type PostDispatchStepContext } from './post-dispatch-steps.js';
import type { MonitorResult } from './run-monitor.js';
import { deleteTestRunIfPresent } from './test-fixtures.js';

const watched: MonitorResult = {
  pollCount: 1,
  exitReason: 'worker-done',
  violations: [],
  snapshots: [],
};

function context(
  monitorRunForStep: PostDispatchStepContext['monitorRunForStep'],
): PostDispatchStepContext {
  return {
    activeMonitors: new Map(),
    blockedRunError: (message, reason) => new Error(`${reason}: ${message}`),
    broadcastFn: () => {},
    createEngineDecision: async () => 'decision-unused',
    executeNoChangeGate: async () => {},
    executePublishGateReviewPlan: async () => ({ reviewIds: [] }),
    executeReadyGate: async () => 'ready',
    executeReviewGate: async () => {},
    getDiffStat: async () => ({ files: 1, additions: 1, deletions: 0 }),
    interactiveLightweightSkipOutputs: () => ({ outputs: { skipped: true } }),
    isHumanGateEnabled: async () => true,
    monitorTerminalError: ({ reason }) => new Error(reason),
    refreshRunLinks: async () => {},
    stepPartialIO: new Map(),
    deferTerminalSlotRelease: () => {},
    monitorRunForStep,
    monitorTransportRetryDelaysMs: [0, 0],
  };
}

function monitoringRun(t: test.TestContext) {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: 'MONITOR-RECONNECT' });
  t.after(() => deleteTestRunIfPresent(run.id));
  updateRun(run.id, { status: 'monitoring', slotId: 'reconnect-slot' });
  return run;
}

const lostNode = () =>
  new NodeTransportUnavailableError(
    'macpro',
    'disconnected',
    'Node macpro connection closed before it replied',
  );

test('a monitor that lost its node connection watches again and finishes', async (t) => {
  const run = monitoringRun(t);
  let watches = 0;
  const io = await executeMonitorStep(
    run.id,
    context(async () => {
      if (++watches === 1) throw lostNode();
      return watched;
    }),
  );
  assert.equal(watches, 2);
  assert.equal(io.outputs?.exitReason, 'worker-done');
});

test('the monitor retry is bounded, and other monitor errors are not retried', async (t) => {
  const run = monitoringRun(t);
  let watches = 0;
  await assert.rejects(
    executeMonitorStep(
      run.id,
      context(async () => {
        watches++;
        throw lostNode();
      }),
    ),
    NodeTransportUnavailableError,
  );
  assert.equal(watches, 3, 'the first watch and two retries');

  watches = 0;
  await assert.rejects(
    executeMonitorStep(
      run.id,
      context(async () => {
        watches++;
        throw new Error('monitor bug');
      }),
    ),
    /monitor bug/,
  );
  assert.equal(watches, 1);
});
