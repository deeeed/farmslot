import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FLOW_STEPS,
  pipelineStepsForRun,
  prCompletionClaimReviewSupported,
  runOutputReviewEnabled,
} from '../../src/index.js';

test('only new PR-completion contracts add conditional REVIEW before COMPLETE', () => {
  const legacy = pipelineStepsForRun({ flowType: 'pr-complete' });
  assert.equal(legacy.includes('review'), false);
  const current = pipelineStepsForRun({ flowType: 'pr-complete', acceptanceContractVersion: 1 });
  assert.equal(current[current.indexOf('complete') - 1], 'review');
  assert.equal(FLOW_STEPS['pr-complete'].includes('review'), false);
});

test('fresh captured claim review is available without changing completion policy', () => {
  const run = {
    flowType: 'pr-complete' as const,
    acceptanceContractVersion: 1 as const,
    lane: 'production' as const,
  };
  assert.equal(prCompletionClaimReviewSupported(run), true);
  assert.equal(runOutputReviewEnabled(run), false);
  const hold = {
    state: 'held' as const,
    registrationRevision: 2,
    contractRevision: 2,
    headSha: 'a'.repeat(40),
  };
  assert.equal(runOutputReviewEnabled({ ...run, acceptanceProofHold: hold }), true);
  assert.equal(
    runOutputReviewEnabled({ ...run, acceptanceProofHold: { ...hold, state: 'reviewed' } }),
    false,
  );
  assert.equal(prCompletionClaimReviewSupported({ ...run, lane: 'comparison' }), false);
});
