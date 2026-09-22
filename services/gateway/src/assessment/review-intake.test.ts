import assert from 'node:assert/strict';
import test from 'node:test';

import type { AssessmentResult, PRRuleSubject } from '@farmslot/protocol';

import { assessReviewIntake, reviewIntakeRecommendation } from './review-intake.js';

test('review intake keeps unavailable assessment on the stronger-reviewer path', async () => {
  const subject: PRRuleSubject = {
    pr: { host: 'github.com', repo: 'example/repo', number: 1 },
    headSha: 'head',
    title: 'Change the wallet button',
    observedAt: new Date().toISOString(),
    facts: {},
  };
  const result = await assessReviewIntake(subject);
  assert.equal(result.assessment.status, 'disabled');
  assert.equal(result.route, 'needs-review');
  assert.equal(result.visualReviewRequired, false);
});

const confident: AssessmentResult = {
  status: 'completed',
  answers: {
    risk: { type: 'choice', choice: 'low', confidence: 1, probabilities: { low: 1 } },
    visualReview: { type: 'boolean', probability: 0.1 },
    reviewSurface: {
      type: 'choice',
      choice: 'static',
      confidence: 0.9,
      probabilities: { static: 0.9, multimodal: 0.1 },
    },
  },
};
test('uncertainty policy refuses missing, conflicting and low-confidence visual evidence', () => {
  assert.equal(reviewIntakeRecommendation(confident).route, 'standard-review');
  for (const answers of [
    { ...confident.answers, visualReview: undefined },
    {
      ...confident.answers,
      visualReview: { type: 'boolean' as const, probability: 0.53 },
      reviewSurface: {
        type: 'choice' as const,
        choice: 'multimodal',
        confidence: 0.18,
        probabilities: { multimodal: 0.18, static: 0.82 },
      },
    },
    { ...confident.answers, visualReview: { type: 'boolean' as const, probability: 0.9 } },
  ]) {
    const filtered = Object.fromEntries(
      Object.entries(answers).filter(
        (entry): entry is [string, NonNullable<(typeof entry)[1]>] => entry[1] !== undefined,
      ),
    );
    assert.equal(
      reviewIntakeRecommendation({ ...confident, answers: filtered }).route,
      'needs-review',
    );
  }
});
