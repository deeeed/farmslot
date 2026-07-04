import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isRecipeQualityArtifact } from '../../src/index.js';

function validArtifact(): unknown {
  return {
    version: 1,
    verdict: 'pass',
    compact: {
      verdict: 'PASS',
      reasons: ['Recipe proves the claim.'],
      better_version_guidance: [],
    },
    dimensions: {},
    structural_findings: [],
    contextual_findings: [],
    suggested_recipe_delta: [],
    training_fields: {
      project: 'example-farm',
      flow_type: 'fix-bug',
      proof_mode: 'mixed',
    },
    meta: {
      producer: 'worker',
      fallback_used: false,
      legacy_task: false,
      artifact_required: true,
      source_signals: ['recipe-quality.json'],
    },
  };
}

test('validates RecipeQualityArtifact contract', () => {
  assert.equal(isRecipeQualityArtifact(validArtifact()), true);
});

test('rejects invalid nested RecipeQualityArtifact fields', () => {
  assert.equal(
    isRecipeQualityArtifact({
      ...validArtifact(),
      compact: { verdict: 'PASS' },
    }),
    false,
  );
  assert.equal(
    isRecipeQualityArtifact({
      ...validArtifact(),
      training_fields: { proof_mode: 'bogus' },
    }),
    false,
  );
  assert.equal(
    isRecipeQualityArtifact({
      ...validArtifact(),
      meta: {
        producer: 'worker',
        fallback_used: false,
        legacy_task: false,
        artifact_required: true,
        fallback_source: 'worker',
        source_signals: ['recipe-quality.json'],
      },
    }),
    false,
  );
});
