import assert from 'node:assert/strict';
import test from 'node:test';

import { isRunningReview } from './review-placement-proof-state.mjs';

for (const status of [
  'paused',
  'blocked',
  'human-gating',
  'needs-decision',
  'done',
  'failed',
  'cancelled',
]) {
  test(`retained ${status} reviews do not satisfy running proof`, () => {
    assert.equal(isRunningReview({ status }), false);
  });
}
test('a monitoring review satisfies running proof', () => {
  assert.equal(isRunningReview({ status: 'monitoring' }), true);
});
