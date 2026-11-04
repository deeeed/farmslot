import assert from 'node:assert/strict';
import test from 'node:test';

import '../runtime/mock-pty.test-support.js';

import { reviewerScratchRule } from './review-agent.js';

test('static reviewer contract forbids launching validation and reads recorded CI evidence', () => {
  const contract = reviewerScratchRule('review-policy-guard');
  assert.match(contract, /static.code/i);
  assert.match(contract, /CI results|CI receipts/);
  assert.match(contract, /unverified/i);
  assert.doesNotMatch(contract, /Put probe tests|probe must sit|reviewer_recipe_replay\(|mkdir -p/);
});
