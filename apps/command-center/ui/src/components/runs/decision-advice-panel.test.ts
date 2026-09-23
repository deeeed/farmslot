import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { supportsDecisionAdvice } from './decision-advice-model.js';

test('advice is limited to pending decisions with two non-decline choices', () => {
  const actions = [
    { id: 'apply', label: 'Apply', description: 'Acquire the resource', style: 'primary' as const },
    {
      id: 'continue',
      label: 'Continue',
      description: 'Continue with the existing resource',
      style: 'secondary' as const,
    },
    { id: 'cancel', label: 'Cancel', style: 'danger' as const },
  ];
  const eligible = { type: 'engine_collision' as const, actions };
  assert.equal(supportsDecisionAdvice(eligible), true);
  assert.equal(
    supportsDecisionAdvice({
      ...eligible,
      actions: [{ ...actions[0], description: '' }, ...actions.slice(1)],
    }),
    false,
  );
  assert.equal(supportsDecisionAdvice({ ...eligible, type: 'engine_review_posting' }), false);
  assert.equal(supportsDecisionAdvice({ ...eligible, resolvedAt: '2026-09-23T00:00:00Z' }), false);
  assert.equal(supportsDecisionAdvice({ ...eligible, actions: [actions[0], actions[2]] }), false);
  assert.equal(
    supportsDecisionAdvice({
      ...eligible,
      actions: [actions[2], { ...actions[2], id: 'abort' }, actions[0]],
    }),
    false,
  );
  assert.equal(
    supportsDecisionAdvice({ ...eligible, actions: [actions[0], actions[0], actions[2]] }),
    false,
  );
});
