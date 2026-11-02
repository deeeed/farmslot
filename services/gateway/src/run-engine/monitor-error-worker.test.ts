// F328 ce1c5583, 2026-11-02: the resumed monitor threw "terminated", the engine failed the run,
// and the failure teardown sent /exit to the live Pi worker. A monitor error is not a worker
// outcome; the worker and its slot stay for an operator.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { FLOW_STEPS, PipelineSteps as S, type Run, type RunStep } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { makeRun } from './test-fixtures.js';

let run: Run;
const released: string[] = [];
const killed: string[] = [];

mock.module('./post-dispatch-steps.js', {
  namedExports: {
    executeMonitorStep: async () => {
      throw new Error('terminated');
    },
    executeCompleteStep: async () => {
      throw new Error('Unexpected complete');
    },
    executeHumanGateStep: async () => {
      throw new Error('Unexpected gate');
    },
    executeReviewStep: async () => {
      throw new Error('Unexpected review');
    },
    holdInteractiveCompletionForOperator: () => {
      throw new Error('Unexpected hold');
    },
    isFlowTerminalStep: () => false,
    readyGateReviewSubjectMatches: () => false,
    persistedUpdateBranchNeedsReview: () => false,
    shouldSkipRetrospectiveAtComplete: () => false,
    baseReviewPolicy: () => {
      throw new Error('Unexpected policy');
    },
    holdSlotForPublicationGate: () => {
      throw new Error('Unexpected hold');
    },
    rerunReviewIfReviewedInputsChanged: () => {
      throw new Error('Unexpected review');
    },
  },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) => (run?.id === id ? run : undefined),
    getAllRuns: () => (run ? [run] : []),
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
    updateRunStep: (_id: string, name: string, patch: Partial<RunStep>) =>
      Object.assign(run.steps.find((step) => step.name === name)!, patch),
    persistRunNow: async () => {},
  },
});
mock.module('../server.js', { namedExports: { broadcastEvent: () => {} } });
const backlog = await import('../backlog/store.js');
mock.module('../backlog/store.js', {
  namedExports: { ...backlog, markBacklogRunObserved: async () => undefined },
});
const posture = await import('./resource-posture.js');
mock.module('./resource-posture.js', {
  namedExports: { ...posture, reconcileRunPosture: async () => ({ result: undefined }) },
});
// The run owns its slot, so a failed run's cleanup releases it, which sends the worker /exit.
const core = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    readSlotRow: async (slot: string) => ({ slot, current_run_id: run.id, agent: 'working' }),
    ownsRunSlotCleanup: () => true,
  },
});
const lifecycle = await import('../methods/run/lifecycle-control.js');
mock.module('../methods/run/lifecycle-control.js', {
  namedExports: {
    ...lifecycle,
    releaseCompletedRunSlot: async (owner: Run) => {
      released.push(owner.id);
    },
  },
});
const nudge = await import('../methods/dispatch/nudge.js');
mock.module('../methods/dispatch/nudge.js', {
  namedExports: {
    ...nudge,
    teardownWorkerOnSlot: async (slot: string) => {
      killed.push(slot);
    },
  },
});
const { startRun } = await import('./orchestrator.js');

test('a monitor error leaves the live worker and its slot to an operator', async () => {
  const steps = FLOW_STEPS['fix-bug'];
  run = makeRun({
    id: 'ce1c5583-dd9f-4664-87f2-b64f02941ee7',
    flowType: 'fix-bug',
    status: 'monitoring',
    slotId: 'macpro-mm-5',
    engineState: { generation: 1 },
    steps: steps.map((name, index) => ({
      name,
      status: index < steps.indexOf(S.MONITOR) ? 'done' : 'pending',
    })),
  });
  const worker = {
    id: 'fix-bug',
    role: 'fix-bug' as const,
    label: 'Fix bug',
    runner: 'pi',
    status: 'working' as const,
    slotId: 'macpro-mm-5',
    runId: run.id,
  };
  run.agentContexts = [worker];

  await startRun(run.id);

  assert.deepEqual(released, [], 'the slot is not released, so the worker gets no /exit');
  assert.deepEqual(killed, [], 'the worker is not killed');
  assert.equal(run.status, 'reconciling');
  assert.match(run.error ?? '', /^terminated\n/);
  assert.equal(run.completedAt, undefined);
  assert.equal(run.slotId, 'macpro-mm-5');
  assert.deepEqual(run.agentContexts, [worker]);
  assert.equal(run.steps.find((step) => step.name === S.MONITOR)?.status, 'failed');
  assert.equal(run.steps.find((step) => step.name === S.REVIEW)?.status, 'pending');
});
