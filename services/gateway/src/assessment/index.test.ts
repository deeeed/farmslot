import assert from 'node:assert/strict';
import test from 'node:test';

import { assess } from './index.js';

const request = {
  state: { diff: 'changed button label' } as const,
  questions: {
    visual: { type: 'boolean' as const, instructions: 'Does this require visual review?' },
  },
};

test('assessment is disabled when no explicit opt-in is present', async () => {
  const previous = process.env.FARMSLOT_ASSESSMENT_ENABLED;
  delete process.env.FARMSLOT_ASSESSMENT_ENABLED;
  try {
    const result = await assess(request);
    assert.equal(result.status, 'disabled');
    assert.equal(result.answers, undefined);
    assert.match(result.stateHash ?? '', /^[a-f0-9]{64}$/);
  } finally {
    if (previous === undefined) delete process.env.FARMSLOT_ASSESSMENT_ENABLED;
    else process.env.FARMSLOT_ASSESSMENT_ENABLED = previous;
  }
});

test('explicit assessment with no provider key is skipped without exposing credentials', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const result = await assess({ ...request, provider: 'typesafe', enabled: true });
    assert.equal(result.status, 'skipped');
    assert.doesNotMatch(result.error ?? '', /TYPESAFE_API_KEY|Bearer/);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('unknown provider is unavailable and does not change the normal workflow', async () => {
  const result = await assess({ ...request, provider: 'missing-provider', enabled: true });
  assert.equal(result.status, 'unavailable');
  assert.match(result.error ?? '', /unknown structured assessment provider/);
});
