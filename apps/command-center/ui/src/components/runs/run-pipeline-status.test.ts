import assert from 'node:assert/strict';
import test from 'node:test';

import { colors } from '../../styles/theme-tokens.js';

import {
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
});
