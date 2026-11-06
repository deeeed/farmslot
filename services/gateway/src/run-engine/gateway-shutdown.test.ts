import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { FLOW_STEPS, PipelineSteps as S, type Run } from '@farmslot/protocol';

import '../runtime/mock-pty.test-support.js';

import { beginGatewayShutdown } from '../core/gateway-shutdown.js';
import { PublishPackageRefusedError } from '../run-completion/publish-package-refused.js';

import { makeRun } from './test-fixtures.js';

const runs = new Map<string, Run>();
const pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
let entered = 0;
mock.module('../runners/run-progress.js', {
  namedExports: {
    readRunProgress: async () => ({ kind: 'idle', activeRole: 'primary' }),
    runDecisionWaitingStatus: (run: Run) => run.status,
  },
});
mock.module('./post-dispatch-steps.js', {
  namedExports: {
    executeCompleteStep: async (id: string) => {
      entered++;
      if (id === 'normal-refusal') throw new PublishPackageRefusedError('Invalid evidence');
      await new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }));
      return { outputs: { artifactsCopied: true } };
    },
    executeHumanGateStep: async () => assert.fail('shutdown must not enter the next step'),
    executeMonitorStep: async () => assert.fail('unexpected monitor'),
    executeReviewStep: async () => assert.fail('unexpected review'),
    holdInteractiveCompletionForOperator: () => assert.fail('unexpected hold'),
    isFlowTerminalStep: () => false,
    readyGateReviewSubjectMatches: () => false,
    persistedUpdateBranchNeedsReview: () => false,
    shouldSkipRetrospectiveAtComplete: () => false,
    baseReviewPolicy: () => assert.fail('unexpected policy'),
    holdSlotForPublicationGate: () => assert.fail('unexpected publication'),
    rerunReviewIfReviewedInputsChanged: () => assert.fail('unexpected review'),
  },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) => runs.get(id),
    updateRun: (id: string, patch: Partial<Run>) => Object.assign(runs.get(id)!, patch),
    updateRunStep: (id: string, name: string, patch: Partial<Run['steps'][number]>) =>
      Object.assign(runs.get(id)!.steps.find((step) => step.name === name)!, patch),
  },
});
const { startRun } = await import('./orchestrator.js');

function completionRun(id: string): Run {
  const steps = FLOW_STEPS['pr-complete'];
  const run = makeRun({
    id,
    flowType: 'pr-complete',
    slotId: null,
    engineState: { generation: 0 },
    steps: steps.map((name, index) => ({
      name,
      status: index < steps.indexOf(S.COMPLETE) ? 'done' : 'pending',
    })),
  });
  runs.set(id, run);
  return run;
}

test('a real package refusal outside gateway shutdown still fails closed', async () => {
  const run = completionRun('normal-refusal');
  await startRun(run.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.steps.find((step) => step.name === S.COMPLETE)?.status, 'failed');
  assert.equal(run.error, 'Invalid evidence');
});

test('shutdown leaves both late refusal and successful steps running for restart recovery', async () => {
  const failed = completionRun('shutdown-refusal');
  const completed = completionRun('shutdown-success');
  const driving = [startRun(failed.id), startRun(completed.id)];
  for (let count = 0; pending.size < 2 && count < 1000; count++) await Promise.resolve();
  assert.equal(pending.size, 2);
  beginGatewayShutdown();
  pending
    .get(failed.id)!
    .reject(
      new PublishPackageRefusedError('Artifact mirror refresh failed: Node is shutting down.'),
    );
  pending.get(completed.id)!.resolve();
  await Promise.all(driving);
  for (const run of [failed, completed]) {
    assert.equal(run.status, 'completing');
    assert.equal(run.steps.find((step) => step.name === S.COMPLETE)?.status, 'running');
    assert.equal(run.error, undefined);
    assert.ok(
      run.steps
        .slice(FLOW_STEPS['pr-complete'].indexOf(S.COMPLETE) + 1)
        .every((step) => step.status === 'pending'),
    );
  }
  const before = entered;
  const notStarted = completionRun('after-shutdown');
  await startRun(notStarted.id);
  assert.equal(entered, before, 'shutdown cannot admit another pipeline');
});
