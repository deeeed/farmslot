import assert from 'node:assert/strict';
import test from 'node:test';

import { recordingAcceptanceReview } from './acceptance-evidence';
import { visualJudgmentAvailable } from './visual-claim-review';

test('Looks right / Issue act only with a bound verdict and a current way to send it', () => {
  const record = async () => {};
  assert.equal(visualJudgmentAvailable({ reviewKind: 'person-reviewed' }, record), true);
  assert.equal(visualJudgmentAvailable({ reviewKind: null }, record), false, 'evidence binds none');
  assert.equal(
    visualJudgmentAvailable({ reviewKind: 'person-reviewed' }, undefined),
    false,
    'the run takes no commands (Run Detail and the overlay pass no callback then)',
  );
  assert.equal(
    visualJudgmentAvailable({ reviewKind: 'person-reviewed' }, record, true),
    false,
    'the screen disables it',
  );
  // The recording's overlay after newer evidence: its review drops the callback.
  const stale = recordingAcceptanceReview({ rows: [], evidenceKey: 'B', record }, 'A');
  assert.equal(visualJudgmentAvailable({ reviewKind: 'person-reviewed' }, stale?.record), false);
});
