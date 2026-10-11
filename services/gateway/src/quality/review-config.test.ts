import assert from 'node:assert/strict';
import test from 'node:test';

import { assertCurrentReviewConfiguration } from './review-config.js';

test('removed queued review fields fail with a conversion hint', () => {
  assert.throws(
    () => assertCurrentReviewConfiguration({ reviewDepth: {} }, 'queue'),
    /was removed.*Convert stored review configuration/,
  );
  assert.doesNotThrow(() =>
    assertCurrentReviewConfiguration(
      {
        reviewPolicy: { minimumReviews: 1 },
        reviewSequence: [{ runner: 'codex', model: null, effort: null, mode: 'cold' }],
      },
      'queue',
    ),
  );
});
