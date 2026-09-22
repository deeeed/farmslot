import assert from 'node:assert/strict';
import test from 'node:test';

import { resetAssessmentConfigForTests } from '../assessment/config.js';

import { assessmentStatus, assessmentTest } from './assessment.js';

test('assessment status reports providers and never returns the credential', () => {
  const previous = process.env.TYPESAFE_API_KEY;
  const previousProvider = process.env.FARMSLOT_ASSESSMENT_PROVIDER;
  process.env.TYPESAFE_API_KEY = 'private-test-key';
  process.env.FARMSLOT_ASSESSMENT_PROVIDER = 'typesafe';
  resetAssessmentConfigForTests();
  try {
    const result = assessmentStatus();
    assert.equal(result.enabled, false);
    assert.equal(result.keyAvailable, true);
    assert.equal(result.providers[0]?.id, 'typesafe');
    assert.equal(JSON.stringify(result).includes('private-test-key'), false);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
    if (previousProvider === undefined) delete process.env.FARMSLOT_ASSESSMENT_PROVIDER;
    else process.env.FARMSLOT_ASSESSMENT_PROVIDER = previousProvider;
    resetAssessmentConfigForTests();
  }
});

test('assessment test remains optional when the configured provider has no key', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const result = await assessmentTest({ provider: 'typesafe' });
    assert.equal(result.status, 'skipped');
    assert.match(result.error ?? '', /not configured/);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});
