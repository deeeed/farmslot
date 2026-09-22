import assert from 'node:assert/strict';
import test from 'node:test';

import type { PRRuleSubject } from '@farmslot/protocol';

import { assessReviewIntake } from './review-intake.js';

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
  assert.equal(result.route, 'strong-reviewer');
  assert.equal(result.visualReviewRequired, false);
});
