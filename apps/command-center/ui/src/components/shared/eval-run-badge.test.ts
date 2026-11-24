import assert from 'node:assert/strict';
import test from 'node:test';

import { evalRunBadge, isEvalRun } from './eval-run-badge.js';

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

test('when the flow badge already reads EVAL, the marker names only the variant', () => {
  assert.equal(evalRunBadge({ lane: 'comparison', variant: 'glm-lite' }, true)?.label, 'glm-lite');
  assert.equal(evalRunBadge({ lane: 'comparison', variant: null }, true), null);
});
