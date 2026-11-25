import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evalRunBadge,
  isEvalRun,
  productFamiliesFirst,
  productRunsFirst,
} from '../../src/runs/eval-runs.js';

test('eval runs carry an EVAL badge with their compared variant; product runs carry none', () => {
  assert.deepEqual(evalRunBadge({ lane: 'comparison', variant: 'glm-c3b' }), {
    label: 'EVAL · glm-c3b',
    title: 'Evaluation run (comparison lane), variant glm-c3b',
  });
  assert.equal(evalRunBadge({ lane: 'comparison', variant: null })?.label, 'EVAL');
  assert.equal(evalRunBadge({ lane: 'production', variant: 'glm-c3b' }), null);
  assert.equal(evalRunBadge({ lane: 'validation' }), null);
  assert.equal(isEvalRun({ lane: 'comparison' }), true);
  assert.equal(isEvalRun({}), false);
});

test('when the flow label already reads EVAL, the marker names only the variant', () => {
  assert.equal(evalRunBadge({ lane: 'comparison', variant: 'glm-lite' }, true)?.label, 'glm-lite');
  assert.equal(evalRunBadge({ lane: 'comparison', variant: null }, true), null);
});

test('product runs list before eval runs, each keeping its own order', () => {
  const runs = [
    { id: 'eval-new', lane: 'comparison' as const },
    { id: 'product-mid', lane: 'production' as const },
    { id: 'eval-old', lane: 'comparison' as const },
    { id: 'validation-old', lane: 'validation' as const },
  ];
  assert.deepEqual(
    productRunsFirst(runs).map((run) => run.id),
    ['product-mid', 'validation-old', 'eval-new', 'eval-old'],
  );
});

test('families of only eval runs list after product families; mixed families stay with product', () => {
  const evalFamily = { id: 'eval', runs: [{ lane: 'comparison' as const }] };
  const mixedFamily = {
    id: 'mixed',
    runs: [{ lane: 'production' as const }, { lane: 'comparison' as const }],
  };
  const productFamily = { id: 'product', runs: [{ lane: 'production' as const }] };
  assert.deepEqual(
    productFamiliesFirst([evalFamily, mixedFamily, productFamily]).map((group) => group.id),
    ['mixed', 'product', 'eval'],
  );
});
