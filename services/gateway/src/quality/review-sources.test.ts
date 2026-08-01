import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTRA_REVIEW_SOURCE,
  inferReviewSourceKind,
  REVIEW_SOURCES,
  reviewCompositeKey,
  reviewLoopNumberFromId,
  type ReviewSourceKind,
  SELF_REVIEW_SOURCE,
} from './review-sources.js';

test('SELF_REVIEW_SOURCE owns the `self-review-${N}` namespace', () => {
  const refs = SELF_REVIEW_SOURCE.artifactRefs(3);
  assert.equal(refs.id, 'self-review-3');
  assert.equal(refs.jsonRel, 'artifacts/self-review-3.json');
  assert.equal(refs.mdRel, 'artifacts/self-review-3.md');
});

test('EXTRA_REVIEW_SOURCE owns the `independent-review-${N}` namespace', () => {
  const refs = EXTRA_REVIEW_SOURCE.artifactRefs(2);
  assert.equal(refs.id, 'independent-review-2');
  assert.equal(refs.jsonRel, 'artifacts/independent-review-2.json');
  assert.equal(refs.mdRel, 'artifacts/independent-review-2.md');
});

test('self-review and extra-review IDs never collide on the same loopNumber', () => {
  // Regression guard for the bug that erased operator-requested cross-runner
  // reviews when a self-review attempt landed on the matching loopNumber.
  for (let n = 1; n <= 10; n++) {
    const selfId = SELF_REVIEW_SOURCE.artifactRefs(n).id;
    const extraId = EXTRA_REVIEW_SOURCE.artifactRefs(n).id;
    assert.notEqual(selfId, extraId, `loopNumber ${n} collides across sources`);
  }
});

test('REVIEW_SOURCES registry exposes both kinds keyed by kind', () => {
  assert.equal(REVIEW_SOURCES['self-review'], SELF_REVIEW_SOURCE);
  assert.equal(REVIEW_SOURCES['extra-review'], EXTRA_REVIEW_SOURCE);
});

test('reviewCompositeKey distinguishes streams sharing a loopNumber', () => {
  assert.notEqual(reviewCompositeKey('self-review', 2), reviewCompositeKey('extra-review', 2));
  assert.equal(reviewCompositeKey('self-review', 2), 'self-review::2');
  assert.equal(reviewCompositeKey('extra-review', 2), 'extra-review::2');
});

test('reviewLoopNumberFromId parses only the source-owned positive suffix', () => {
  assert.equal(reviewLoopNumberFromId(EXTRA_REVIEW_SOURCE, 'independent-review-7'), 7);
  assert.equal(reviewLoopNumberFromId(EXTRA_REVIEW_SOURCE, 'self-review-7'), null);
  assert.equal(reviewLoopNumberFromId(EXTRA_REVIEW_SOURCE, 'independent-review-0'), null);
  assert.equal(reviewLoopNumberFromId(EXTRA_REVIEW_SOURCE, 'independent-review-x'), null);
});

test('inferReviewSourceKind classifies by id prefix from the registry', () => {
  assert.equal(inferReviewSourceKind({ id: 'self-review-1' }), 'self-review');
  assert.equal(inferReviewSourceKind({ id: 'self-review-12' }), 'self-review');
  assert.equal(inferReviewSourceKind({ id: 'independent-review-2' }), 'extra-review');
});

test('inferReviewSourceKind throws on unknown ids', () => {
  // Pre-launch contract: every review entry must come from a ReviewSource.
  // An unknown id is a programming bug — silently bucketing would invite the
  // same id-collision regression this PR fixed.
  assert.throws(() => inferReviewSourceKind({ id: 'foo-1' }), /Unknown review id prefix/);
  assert.throws(() => inferReviewSourceKind({ id: '' }), /Unknown review id prefix/);
});

test('REVIEW_SOURCES is frozen and source kinds are exhaustive', () => {
  const kinds: ReviewSourceKind[] = ['self-review', 'extra-review'];
  for (const kind of kinds) {
    assert.ok(REVIEW_SOURCES[kind], `missing registry entry for ${kind}`);
    assert.equal(REVIEW_SOURCES[kind].kind, kind);
  }
  assert.ok(Object.isFrozen(REVIEW_SOURCES));
  assert.ok(Object.isFrozen(SELF_REVIEW_SOURCE));
  assert.ok(Object.isFrozen(EXTRA_REVIEW_SOURCE));
});
