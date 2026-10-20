import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evidenceReviewerHash,
  evidenceReviewerViewFromHash,
  evidenceReviewerViewKey,
} from './evidence-reviewer-url-state.js';

test('a review view round-trips through the hash, other params kept', () => {
  const view = { claimId: 'AC-2', path: 'artifacts/stills/a.webp', atMs: 78_250, check: 0 };
  const hash = evidenceReviewerHash(view, '#runs?run=r1&tab=evidence');
  assert.match(hash, /run=r1/);
  assert.match(hash, /tab=evidence/);
  assert.deepEqual(evidenceReviewerViewFromHash(hash), { ...view, atMs: 78_300 });
});

test('closing the review drops only its params', () => {
  const hash = evidenceReviewerHash(
    null,
    '#runs?run=r1&review=AC-2&reviewFile=a.webp&reviewAt=3.0&reviewCheck=4',
  );
  assert.equal(hash, '#runs?run=r1');
  assert.equal(evidenceReviewerViewFromHash(hash), null);
});

test('a malformed time or step is ignored, not applied', () => {
  assert.deepEqual(evidenceReviewerViewFromHash('#runs?review=AC-1&reviewAt=x&reviewCheck=1.5'), {
    claimId: 'AC-1',
  });
});

test('the view key matches what the link records, to a tenth of a second', () => {
  const shown = { claimId: 'AC-2', atMs: 78_213 };
  const linked = evidenceReviewerViewFromHash(evidenceReviewerHash(shown, '#runs?run=r1'));
  assert.equal(evidenceReviewerViewKey(shown), evidenceReviewerViewKey(linked));
  assert.notEqual(evidenceReviewerViewKey(shown), evidenceReviewerViewKey({ ...shown, check: 2 }));
  assert.equal(evidenceReviewerViewKey(null), '');
});
