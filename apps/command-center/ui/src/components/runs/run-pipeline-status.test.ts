import assert from 'node:assert/strict';
import test from 'node:test';

import { colors } from '../../styles/theme-tokens.js';

import {
  computePackageRefreshStatus,
  isPostGateReviewOrFixInFlight,
  isRecoverablePublishFailure,
  pipelineStepTone,
  pipelineToneColor,
  publicationReviewVerdictStatus,
  publicationReviewVerdictTone,
} from './run-pipeline-status.js';

test('publication review issues are reworkable (warn), not terminal fail', () => {
  assert.equal(publicationReviewVerdictStatus('issues'), 'failed');
  assert.equal(publicationReviewVerdictTone('issues'), 'warn');
  assert.equal(pipelineToneColor('warn'), colors.statusWarn);
});

test('publication review failed is terminal red', () => {
  assert.equal(publicationReviewVerdictStatus('failed'), 'failed');
  assert.equal(publicationReviewVerdictTone('failed'), 'fail');
  assert.equal(pipelineToneColor('fail'), colors.statusFail);
});

test('publication review pass is green done', () => {
  assert.equal(publicationReviewVerdictStatus('pass'), 'done');
  assert.equal(publicationReviewVerdictTone('pass'), 'ok');
});

test('pipelineStepTone uses review verdict outputs for mini+canvas parity', () => {
  assert.equal(
    pipelineStepTone({
      name: 'requested 1',
      status: 'failed',
      outputs: { verdict: 'issues' },
    }),
    'warn',
  );
  assert.equal(
    pipelineStepTone({
      name: 'requested 2',
      status: 'failed',
      outputs: { verdict: 'failed' },
    }),
    'fail',
  );
  assert.equal(
    pipelineStepTone({
      name: 'requested 3',
      status: 'done',
      outputs: { verdict: 'pass' },
    }),
    'ok',
  );
});

test('package-refresh after issues is orange rework, terminal only after review failed', () => {
  assert.equal(
    pipelineStepTone({
      name: 'package-refresh',
      status: 'failed',
      outputs: { lastReviewVerdict: 'issues' },
    }),
    'warn',
  );
  assert.equal(
    pipelineStepTone({
      name: 'package refresh',
      status: 'failed',
      outputs: { lastReviewVerdict: 'failed' },
    }),
    'fail',
  );
  assert.equal(pipelineStepTone({ name: 'package-refresh', status: 'done' }), 'ok');
});

test('finalize package-changed failure is recoverable orange', () => {
  assert.ok(isRecoverablePublishFailure('Package changed; refresh package and re-review'));
  assert.equal(
    pipelineStepTone(
      {
        name: 'finalize',
        status: 'failed',
        detail: 'Package changed; refresh package and re-review before publishing (draft body)',
      },
      { runError: 'Package changed; refresh package and re-review before publishing (draft body)' },
    ),
    'warn',
  );
  assert.equal(
    pipelineStepTone({ name: 'finalize', status: 'failed', detail: 'hard crash' }),
    'fail',
  );
  assert.equal(
    pipelineStepTone({
      name: 'publish',
      status: 'failed',
      detail: 'Package changed; refresh package and re-review before publishing',
    }),
    'warn',
  );
});

test('self-review issues are orange until max retries exhausted (then red)', () => {
  assert.equal(
    pipelineStepTone({
      name: 'self-review',
      status: 'failed',
      outputs: { verdict: 'issues', maxRetriesExhausted: false },
    }),
    'warn',
  );
  assert.equal(
    pipelineStepTone({
      name: 'self-review',
      status: 'failed',
      outputs: { verdict: 'issues', maxRetriesExhausted: true },
    }),
    'fail',
  );
});

test('package-refresh stays pending while post-gate re-review or fix is in flight', () => {
  const failedStatuses = ['failed', 'failed'] as const;
  assert.equal(computePackageRefreshStatus(failedStatuses), 'failed');

  assert.equal(
    computePackageRefreshStatus(failedStatuses, {
      steps: [
        {
          name: 'human-gate',
          status: 'running',
          detail: 'Worker fix complete; running claude re-review (2)...',
        },
      ],
      agentContexts: [],
      engineState: {},
    }),
    'pending',
  );

  assert.equal(
    isPostGateReviewOrFixInFlight({
      steps: [
        {
          name: 'human-gate',
          status: 'running',
          detail: 'Reviewer found 8 issue(s); worker applying fixes (1/3)...',
        },
      ],
      agentContexts: [],
      engineState: {},
    }),
    true,
  );

  assert.equal(
    computePackageRefreshStatus(failedStatuses, {
      steps: [{ name: 'human-gate', status: 'running', detail: 'waiting' }],
      agentContexts: [{ id: 'rev1-claude', role: 'self-review', status: 'working' } as never],
      engineState: {},
    }),
    'pending',
  );

  assert.equal(
    computePackageRefreshStatus(failedStatuses, {
      steps: [{ name: 'human-gate', status: 'running', detail: 'waiting' }],
      agentContexts: [],
      engineState: {
        publishGate: {
          pendingReviewPlan: [{ order: 1, runner: 'claude' }],
        },
      } as never,
    }),
    'pending',
  );
});
