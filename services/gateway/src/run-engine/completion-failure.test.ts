import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { FLOW_STEPS, PipelineSteps as S, type Run } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { GatewayMethodError } from '../core/method-error.js';
import { isCompletionPrerequisiteFailure } from '../run-lifecycle/step-status.js';

import { makeRun } from './test-fixtures.js';

let run: Run;
let kind: 'making-progress' | 'idle' | 'unproven';
let runWrites = 0;
mock.module('../runners/run-progress.js', {
  namedExports: {
    readRunProgress: async () => ({ kind, activeRole: 'primary' }),
    // The former path preserves the active pipeline status and causes the repro.
    runDecisionWaitingStatus: (current: Run) => current.status,
  },
});
mock.module('./post-dispatch-steps.js', {
  namedExports: {
    executeCompleteStep: async () => {
      throw new GatewayMethodError('RUN_GATE_NOT_READY', 'Evidence package unavailable');
    },
    executeHumanGateStep: async () => {
      throw new Error('Unexpected gate');
    },
    executeMonitorStep: async () => {
      throw new Error('Unexpected monitor');
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
    updateRun: (_id: string, patch: Partial<Run>) => {
      runWrites++;
      return Object.assign(run, patch);
    },
    updateRunStep: (_id: string, name: string, patch: Partial<Run['steps'][number]>) =>
      Object.assign(run.steps.find((step) => step.name === name)!, patch),
  },
});
const { startRun } = await import('./orchestrator.js');

for (const observed of ['making-progress', 'idle', 'unproven'] as const) {
  test(`completion prerequisite refusal settles the stopped pipeline with ${observed} worker`, async () => {
    const steps = FLOW_STEPS['pr-complete'];
    run = makeRun({
      id: `completion-${observed}`,
      flowType: 'pr-complete',
      status: 'monitoring',
      slotId: null,
      engineState: { generation: 0 },
      steps: steps.map((name, index) => ({
        name,
        status: index < steps.indexOf(S.COMPLETE) ? 'done' : 'pending',
      })),
    });
    const context = {
      id: 'primary',
      role: 'primary' as const,
      label: 'Primary',
      status: 'working' as const,
      slotId: 'retained-slot',
      runId: run.id,
    };
    run.agentContexts = [context];
    kind = observed;
    await startRun(run.id);
    assert.equal(run.status, 'failed');
    assert.equal(
      isCompletionPrerequisiteFailure(run),
      true,
      'missing error details still retain ownership',
    );
    assert.equal(run.steps.find((step) => step.name === S.COMPLETE)?.status, 'failed');
    assert.ok(
      run.steps.slice(steps.indexOf(S.COMPLETE) + 1).every((step) => step.status === 'skipped'),
    );
    assert.equal(run.error, 'Evidence package unavailable');
    assert.equal(run.metrics.outcome, 'partial');
    assert.deepEqual(run.agentContexts, [context], 'no worker retirement on prerequisite refusal');
    run.slotId = 'retained-slot';
    const retained = structuredClone(run);
    const beforeWrites = runWrites;
    await startRun(run.id);
    assert.equal(runWrites, beforeWrites, 'direct engine re-entry cannot settle or clean up');
    assert.deepEqual(run, retained, 'retained failure, worker and slot are untouched');
  });
}
