import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPipelineVisualJudgments,
  nativeStructuredResult,
  PIPELINE_VISUAL_JUDGMENTS_SCHEMA,
  PIPELINE_VISUAL_RESULT_SCHEMA,
  type PipelineVisualJudgments,
  validateRecipeParamsSchema,
} from '../../src/index.js';
const digest = 'sha256:' + 'a'.repeat(64);
const value: PipelineVisualJudgments = {
  schemaVersion: 1,
  recipeRunId: 'recording',
  closureIdentity: digest,
  judgments: [
    {
      claimId: 'ac1',
      verdict: 'confirmed',
      reason: 'The chart price matches the panel.',
      reviewedFiles: [{ path: 'stills/price.png', digest }],
      moments: [],
    },
  ],
};
test('native visual results use the protocol schema and require actual media references', () => {
  assert.equal(validateRecipeParamsSchema(PIPELINE_VISUAL_JUDGMENTS_SCHEMA).status, 'valid');
  assert.ok(isPipelineVisualJudgments(value));
  assert.deepEqual(nativeStructuredResult(PIPELINE_VISUAL_RESULT_SCHEMA, value)?.value, value);
  assert.ok(
    isPipelineVisualJudgments({
      ...value,
      judgments: [
        {
          ...value.judgments[0],
          reviewedFiles: [],
          moments: [{ recipeRunId: 'recording', videoDigest: digest, traceIndex: 3 }],
        },
      ],
    }),
  );
  assert.equal(
    isPipelineVisualJudgments({
      ...value,
      judgments: [{ ...value.judgments[0], reviewedFiles: [] }],
    }),
    false,
  );
});
test('prose, fabricated actor fields, empty notes and duplicate AC answers do not validate', () => {
  for (const invalid of [
    'PASS',
    { verdict: 'pass' },
    { ...value, actor: 'worker' },
    { ...value, judgments: [{ ...value.judgments[0], reason: ' ' }] },
    { ...value, judgments: [value.judgments[0], value.judgments[0]] },
  ])
    assert.equal(isPipelineVisualJudgments(invalid), false);
});
