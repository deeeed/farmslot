import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completedRunOutcome,
  EVAL_WORKER_BLOCKED_OUTPUT,
  evalWorkerBlockedReason,
} from './blocked-first-output.js';

test('only the monitor step names why a blind eval worker blocked itself', () => {
  const monitor = (outputs: Record<string, unknown>) => ({
    steps: [{ name: 'monitor' as const, status: 'done' as const, outputs }],
  });
  assert.equal(
    evalWorkerBlockedReason(monitor({ [EVAL_WORKER_BLOCKED_OUTPUT]: 'No recipe proof' })),
    'No recipe proof',
  );
  assert.equal(evalWorkerBlockedReason(monitor({ [EVAL_WORKER_BLOCKED_OUTPUT]: true })), undefined);
  assert.equal(evalWorkerBlockedReason(monitor({})), undefined);
  assert.equal(
    evalWorkerBlockedReason({
      steps: [{ name: 'review', status: 'done', outputs: { [EVAL_WORKER_BLOCKED_OUTPUT]: 'x' } }],
    }),
    undefined,
  );
});

test('a run that ends done records partial only when its eval worker blocked itself', () => {
  const steps = (outputs: Record<string, unknown>) => ({
    steps: [{ name: 'monitor' as const, status: 'done' as const, outputs }],
  });
  assert.equal(
    completedRunOutcome(steps({ [EVAL_WORKER_BLOCKED_OUTPUT]: 'No recipe proof' })),
    'partial',
  );
  assert.equal(completedRunOutcome(steps({ workerSignal: { status: 'complete' } })), 'success');
  assert.equal(completedRunOutcome({ steps: [] }), 'success');
});

test('only eval judge skips produce unjudged completion; blocked workers retain partial', () => {
  const steps = [
    {
      name: 'review' as const,
      status: 'done' as const,
      outputs: { skipped: true, reason: 'disabled-for-project' },
    },
  ];
  assert.equal(completedRunOutcome({ steps }), 'success');
  // The completion classifier only needs to know that the run is an eval trial.
  const evalExperiment = {
    experimentId: 'fixture',
    experimentKey: 'fixture',
    experimentManifestPath: 'fixture.json',
    packagePath: 'candidate.json',
    candidateStrategyFingerprint: 'fixture',
    trialId: 'trial',
  };
  assert.equal(completedRunOutcome({ steps, engineState: { evalExperiment } }), 'unjudged');
  assert.equal(
    completedRunOutcome({
      steps: [{ name: 'review', status: 'done', outputs: { verdict: 'pass' } }],
      engineState: { evalExperiment },
    }),
    'success',
  );
  assert.equal(
    completedRunOutcome({
      steps: [
        ...steps,
        {
          name: 'monitor',
          status: 'done',
          outputs: { [EVAL_WORKER_BLOCKED_OUTPUT]: 'No evidence' },
        },
      ],
      engineState: { evalExperiment },
    }),
    'partial',
  );
});
