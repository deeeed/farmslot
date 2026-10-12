import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  conformanceChecksPass,
  type RecipeConformanceCheck,
  type RecipeConformanceLiveEvidence,
  recipeFlowRequirements,
} from '../src/contracts/recipe-conformance.js';

test('selected recipe parameters preserve JSON values and require a smoke before execution', () => {
  const params = {
    text: 'true',
    number: 2,
    flag: false,
    value: null,
    items: ['a,b'],
    nested: { x: 'y=z' },
  };
  assert.deepEqual(
    recipeFlowRequirements({ recipe_checks: ['smoke'], recipe_params: JSON.stringify(params) })
      .params,
    params,
  );
  assert.deepEqual(recipeFlowRequirements(null).params, {});
  for (const recipe_params of ['[1]', 'null', '2', '"text"', '{invalid', {}, true]) {
    assert.throws(
      () => recipeFlowRequirements({ recipe_checks: ['smoke'], recipe_params }),
      /recipe_params/,
    );
  }
  for (const metadata of [
    { recipe_params: '{}' },
    { recipe_actions: ['example.read'] },
    { recipe_hud: true },
    { recipe_capture: true },
  ])
    assert.throws(() => recipeFlowRequirements(metadata), /recipe_checks/);
});

const check: RecipeConformanceCheck = {
  id: 'recipe.smoke',
  status: 'pass',
  required: true,
  message: 'Checked',
  evidence: {
    plan: {
      schemaVersion: 1,
      digest: 'recipe',
      executionContextDigest: 'context',
      source: { kind: 'library', trust: 'trusted' },
      nodes: [],
    },
  },
};

test('conformance needs positive evidence for every required check', () => {
  assert.equal(conformanceChecksPass([]), false);
  assert.equal(conformanceChecksPass([{ ...check, required: false }]), false);
  assert.equal(conformanceChecksPass([check]), true);
  for (const status of ['missing', 'skipped', 'unsupported', 'fail'] as const) {
    assert.equal(conformanceChecksPass([check, { ...check, id: 'other', status }]), false);
  }
  assert.equal(conformanceChecksPass([{ ...check, evidence: undefined }]), false);
});

test('live conformance requires retained smoke and authored teardown evidence', () => {
  assert.equal(conformanceChecksPass([check], 'live'), false);
  const live = {
    smokeTarget: 'effect',
    teardownTarget: 'cleanup',
    artifactDir: '/proof',
    artifacts: [{ path: 'trace.json', digest: 'digest' }],
  };
  const withLive = (value: RecipeConformanceLiveEvidence) => ({
    ...check,
    evidence: { ...check.evidence!, live: value },
  });
  assert.equal(conformanceChecksPass([withLive(live)], 'live'), true);
  assert.equal(conformanceChecksPass([withLive({ ...live, artifacts: [] })], 'live'), false);
  assert.equal(conformanceChecksPass([withLive({ ...live, teardownTarget: '' })], 'live'), false);
  const supported: RecipeConformanceCheck[] = ['capture', 'hud'].map((name) => ({
    id: `${name}.support`,
    required: false,
    status: 'pass',
    message: 'supported',
  }));
  assert.equal(conformanceChecksPass([withLive(live), ...supported], 'live'), false);
  const captured = {
    ...live,
    captureRequired: true,
    hudRequired: true,
    captures: ['proof.png'],
    artifacts: [...live.artifacts, { path: 'proof.png', digest: 'image' }],
  };
  assert.equal(conformanceChecksPass([withLive(captured), ...supported], 'live'), true);
  assert.equal(
    conformanceChecksPass([withLive({ ...captured, captures: [] }), ...supported], 'live'),
    false,
  );
  assert.equal(
    conformanceChecksPass(
      [withLive({ ...captured, captures: ['missing.png'] }), ...supported],
      'live',
    ),
    false,
  );
  assert.equal(
    conformanceChecksPass([withLive({ ...captured, hudRequired: false }), ...supported], 'live'),
    false,
  );
});
