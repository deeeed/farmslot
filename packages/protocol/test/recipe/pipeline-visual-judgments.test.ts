import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPipelineVisualJudgments,
  nativeResultJsonSchema,
  nativeStructuredResult,
  PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA,
  PIPELINE_VISUAL_JUDGMENTS_SCHEMA,
  PIPELINE_VISUAL_RESULT_SCHEMA,
  type PipelineVisualReviewerJudgments,
  validateRecipeParamsSchema,
} from '../../src/index.js';
const digest = 'sha256:' + 'a'.repeat(64);
const value: PipelineVisualReviewerJudgments = {
  schemaVersion: 1,
  recipeRunId: 'recording',
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
test('runner schemas require every property and carry no closure identity', () => {
  // Strict structured output (Codex) refuses a schema with an optional property.
  const walk = (schema: unknown): void => {
    if (typeof schema !== 'object' || !schema || Array.isArray(schema)) return;
    const node = schema as { properties?: Record<string, unknown>; required?: string[] };
    if (node.properties) {
      assert.deepEqual([...(node.required ?? [])].sort(), Object.keys(node.properties).sort());
      assert.ok(!('closureIdentity' in node.properties));
    }
    for (const child of Object.values(schema)) walk(child);
  };
  walk(nativeResultJsonSchema(PIPELINE_VISUAL_RESULT_SCHEMA));
  walk(nativeResultJsonSchema(PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA));
});

test('a closure identity from a runner on the earlier schema is dropped before validation', () => {
  assert.deepEqual(
    nativeStructuredResult(PIPELINE_VISUAL_RESULT_SCHEMA, { ...value, closureIdentity: digest })
      ?.value,
    value,
  );
  const row = { claimId: 'ac2', recipeRunId: 'older', unaffected: true, reason: 'Not touched.' };
  const repair = {
    schemaVersion: 2,
    headSha: 'a'.repeat(40),
    scopeDigest: digest,
    sources: [{ ...value, closureIdentity: digest }],
    retained: [{ ...row, closureIdentity: digest }],
  };
  assert.deepEqual(nativeStructuredResult(PIPELINE_REPAIR_VISUAL_RESULT_SCHEMA, repair)?.value, {
    ...repair,
    sources: [value],
    retained: [row],
  });
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
