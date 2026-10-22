import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertReviewRecommendation,
  renderApprovalPolicy,
  resolveApprovalPolicy,
  reviewRecommendation,
} from '../scripts/review-approval-policy.cjs';

const nits = (count: number) => Array.from({ length: count }, () => ({ severity: 'nit' }));

test('approval thresholds reject the reported three minors and five nits and preserve three harmless nits', () => {
  assert.equal(reviewRecommendation([]), 'APPROVE');
  assert.equal(reviewRecommendation(nits(3)), 'APPROVE');
  assert.equal(reviewRecommendation(nits(4)), 'COMMENT');
  const findings = [...Array.from({ length: 3 }, () => ({ severity: 'minor' })), ...nits(5)];
  assert.equal(reviewRecommendation(findings), 'COMMENT');
  assert.throws(() => assertReviewRecommendation(findings, 'APPROVE'), /require COMMENT/);
  assert.equal(reviewRecommendation([{ severity: 'major' }]), 'REQUEST_CHANGES');
  assert.equal(
    reviewRecommendation([{ severity: 'blocker' }], { majorVerdict: 'APPROVE' }),
    'REQUEST_CHANGES',
  );
  assert.equal(reviewRecommendation([{}]), 'REQUEST_CHANGES');
});

test('configured verdicts compose by strictness and the renderer uses the effective limits', () => {
  const policy = resolveApprovalPolicy({
    maxNits: 0,
    minorVerdict: 'REQUEST_CHANGES',
    majorVerdict: 'COMMENT',
  });
  assert.equal(reviewRecommendation(nits(1), policy), 'COMMENT');
  assert.equal(reviewRecommendation([{ severity: 'major' }], policy), 'COMMENT');
  assert.equal(
    reviewRecommendation([{ severity: 'major' }, { severity: 'minor' }], policy),
    'REQUEST_CHANGES',
  );
  assert.match(renderApprovalPolicy(policy), /more than 0 nits requires COMMENT/);
  assert.match(renderApprovalPolicy(policy), /minor requires REQUEST_CHANGES/);
  assert.match(renderApprovalPolicy(policy), /Size alone is never a finding/);
  assert.match(renderApprovalPolicy(policy), /RIGHT-side added or context line/);
  for (const value of [
    null,
    [],
    { maxNits: -1 },
    { maxNits: 1.5 },
    { minorVerdict: 'pass' },
    { other: true },
  ])
    assert.throws(() => resolveApprovalPolicy(value));
  assert.throws(() => reviewRecommendation([{ severity: 'unknown' }]), /severity/);
});
