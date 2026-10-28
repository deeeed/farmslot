import assert from 'node:assert/strict';
import test from 'node:test';

import { FLOW_STEPS, pipelineStepsForRun, runOutputReviewEnabled } from '../../src/index.js';

test('PR completion never adds a reviewer or captured-output review', () => {
  for (const acceptanceContractVersion of [undefined, 1] as const) {
    const run = {
      flowType: 'pr-complete' as const,
      acceptanceContractVersion,
      lane: 'production' as const,
    };
    assert.deepEqual(pipelineStepsForRun(run), FLOW_STEPS['pr-complete']);
    assert.equal(pipelineStepsForRun(run).includes('review'), false);
    assert.equal(runOutputReviewEnabled(run), false);
    assert.equal(runOutputReviewEnabled({ ...run, completionPolicy: 'artifact-only' }), false);
  }
  assert.equal(
    runOutputReviewEnabled({
      flowType: 'qa',
      completionPolicy: 'artifact-only',
      lane: 'production',
    }),
    true,
  );
});
