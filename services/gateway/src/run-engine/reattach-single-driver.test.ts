import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { FLOW_STEPS, PipelineSteps as S, type Run } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import type { PostDispatchStepContext } from './post-dispatch-steps.js';
import { makeRun } from './test-fixtures.js';

let run: Run;
let monitors = 0;
const reviews: string[] = [];
let writeSignal!: () => void;
const workerSignal = new Promise<void>((resolve) => (writeSignal = resolve));

mock.module('./post-dispatch-steps.js', {
  namedExports: {
    // Follows executeMonitorStep's ownership rule: the monitor registered last
    // owns the signal, and one whose registration was replaced retires.
    executeMonitorStep: async (runId: string, context: PostDispatchStepContext) => {
      monitors++;
      const controller = new AbortController();
      context.activeMonitors.set(runId, controller);
      await workerSignal;
      if (context.activeMonitors.get(runId) !== controller)
        return { inputs: {}, outputs: { exitReason: 'aborted' } };
      context.activeMonitors.delete(runId);
      throw context.monitorTerminalError({
        status: 'blocked',
        outcome: 'partial',
        reason: 'Checklist step blocked',
        stepInputs: {},
        stepOutputs: {},
      });
    },
    executeReviewStep: async (runId: string) => {
      reviews.push(runId);
      throw new Error('Workspace review belongs to another principal');
    },
    executeCompleteStep: async () => {
      throw new Error('Unexpected complete');
    },
    executeHumanGateStep: async () => {
      throw new Error('Unexpected gate');
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
    updateRun: (_id: string, patch: Partial<Run>) => Object.assign(run, patch),
    updateRunStep: (_id: string, name: string, patch: Partial<Run['steps'][number]>) =>
      Object.assign(run.steps.find((step) => step.name === name)!, patch),
  },
});
const { startRun } = await import('./orchestrator.js');

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the engine');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('a re-attached run keeps one monitor, so its blocked signal blocks it', async () => {
  // Run 22e62daa after #1308: auto-recovery re-attached the monitor at
  // generation 1, then startup recovery resumed the same monitoring run.
  const steps = FLOW_STEPS.dev;
  run = makeRun({
    id: '22e62daa-f93e-4f67-a017-7b05a20591e4',
    flowType: 'dev',
    mode: 'autonomous',
    status: 'monitoring',
    // The slot row is not under test; no slot keeps teardown out of it.
    slotId: null,
    engineState: { generation: 1 },
    steps: steps.map((name, index) => ({
      name,
      status:
        index < steps.indexOf(S.MONITOR) ? 'done' : name === S.MONITOR ? 'running' : 'pending',
    })),
  });

  let resumedReturned = false;
  const reattached = startRun(run.id);
  await until(() => monitors === 1);
  const resumed = startRun(run.id).finally(() => (resumedReturned = true));
  // Main starts a second monitor here; the guard returns without one.
  await until(() => monitors === 2 || resumedReturned);
  writeSignal();
  await Promise.all([reattached, resumed]);

  assert.deepEqual(reviews, [], 'the blocked signal never reaches review');
  assert.equal(run.status, 'blocked');
  assert.equal(run.error, 'Checklist step blocked');
  assert.equal(monitors, 1, 'one loop drives a generation');
});
