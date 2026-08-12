import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCopilotCommitAllowed, buildLiveFixHandoff } from './live-fix-policy.js';
import { testCheckout } from './test-helpers.js';

test('live-fix policy preserves pre-existing dirty paths and exact validation/review HEAD', () => {
  const checkout = testCheckout('/operator/farmslot');
  const handoff = buildLiveFixHandoff({
    checkout,
    diff: 'diff --git a/file b/file',
    validationCommands: ['yarn typecheck'],
    reviewHead: checkout.head,
  });
  assert.deepEqual(handoff.dirtyPaths, ['existing-user-change.txt']);
  assert.equal(handoff.head, checkout.head);
  assert.equal(handoff.reviewHead, checkout.head);
  assert.match(handoff.diff, /diff --git/);
});

test('live-fix policy refuses commits on main and mismatched review HEAD', () => {
  const checkout = testCheckout('/operator/farmslot');
  assert.throws(() => assertCopilotCommitAllowed({ ...checkout, branch: 'main' }), /refuses to commit on main/);
  assert.throws(
    () =>
      buildLiveFixHandoff({
        checkout,
        diff: '',
        validationCommands: [],
        reviewHead: 'different-head',
      }),
    /review HEAD must equal/,
  );
});
