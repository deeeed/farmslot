import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareAssessmentInput, validateQuestions } from './input.js';

const questions = {
  risk: {
    type: 'choice' as const,
    instructions: 'What is the risk?',
    criteria: { low: 'Low', high: 'High' },
  },
};

test('assessment input redacts credential-shaped fields and values', () => {
  const result = prepareAssessmentInput(
    { apiKey: 'secret-value', nested: { token: 'another-secret' }, note: 'safe' },
    questions,
    4096,
    'request-key',
  );
  assert.deepEqual(result.state, {
    apiKey: '[REDACTED]',
    nested: { token: '[REDACTED]' },
    note: 'safe',
  });
});

test('assessment input rejects oversized and malformed question data', () => {
  assert.throws(
    () => prepareAssessmentInput({ text: 'x'.repeat(100) }, questions, 20, 'key'),
    /input limit/,
  );
  assert.throws(() => validateQuestions({ __proto__: questions } as unknown), /question/);
});
