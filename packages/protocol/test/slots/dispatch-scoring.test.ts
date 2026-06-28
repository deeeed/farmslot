import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  isDispatchScoreStale,
  SLOT_STALE_BRANCH_SCORE_PENALTY,
} from '../../src/slots/dispatch-scoring.js';

test('SLOT_STALE_BRANCH_SCORE_PENALTY matches dispatch stale threshold', () => {
  assert.equal(SLOT_STALE_BRANCH_SCORE_PENALTY, 50);
  assert.equal(isDispatchScoreStale(49), false);
  assert.equal(isDispatchScoreStale(50), true);
  assert.equal(isDispatchScoreStale(75), true);
});