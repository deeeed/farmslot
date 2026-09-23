import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessmentBooleanValue,
  assessmentChoiceOptions,
  type AssessmentQuestions,
} from '@farmslot/protocol';

import { createLlmAssessmentProvider } from './llm.js';
import { serializeAssessment } from './record-validation.js';

const questions: AssessmentQuestions = {
  cause: {
    type: 'choice',
    instructions: 'Choose cause',
    criteria: { environment: 'Environment', implementation: 'Code' },
  },
  needed: { type: 'boolean', instructions: 'Is more evidence needed?' },
  quality: {
    type: 'score',
    instructions: 'Score the evidence',
    criteria: ['Missing', 'Partial', 'Complete'],
  },
};
const config = {
  id: 'fixture-llm',
  credentialEnv: 'FIXTURE_KEY',
  defaultModel: 'fixture-model',
  baseUrl: 'https://example.invalid/v1',
};
const native = (answers: unknown) =>
  new Response(
    JSON.stringify({
      id: 'resp_test',
      model: 'fixture-model',
      status: 'completed',
      usage: {
        input_tokens: 300,
        output_tokens: 40,
        input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 },
      },
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: JSON.stringify({ answers }) }],
        },
      ],
    }),
    { headers: { 'content-type': 'application/json' } },
  );

test('ordinary LLM judgments use the same service contract without fictional probabilities', async () => {
  let calls = 0;
  const provider = createLlmAssessmentProvider(config, async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema.properties.answers.properties.cause.enum, [
      'environment',
      'implementation',
    ]);
    return native({ cause: 'environment', needed: true, quality: 1.5 });
  });
  const result = await provider.assess({
    state: { error: 'Synthetic error' },
    questions,
    model: 'fixture-model',
    apiKey: 'fixture-key-only',
    signal: new AbortController().signal,
  });
  assert.equal(calls, 1);
  const cause = result.answers.cause;
  assert.equal(cause.type, 'choice');
  assert.deepEqual(assessmentChoiceOptions(cause), ['environment', 'implementation']);
  assert.equal(cause.probabilities, undefined);
  const boolean = result.answers.needed;
  assert.equal(boolean.type, 'boolean');
  assert.equal(assessmentBooleanValue(boolean), true);
  assert.equal(boolean.probability, undefined);
  assert.equal(result.usage.cacheReadTokens, 20);
  serializeAssessment({
    version: 1,
    id: 'fixture-record',
    ownerId: 'fixture-owner',
    consumer: 'smoke-test',
    subject: {},
    startedAt: new Date().toISOString(),
    status: 'completed',
    policyVersion: 'fixture',
    feedback: [],
    result: {
      ...result,
      status: 'completed',
      attempted: true,
      provider: 'fixture-llm',
      requestedModel: 'fixture-model',
      usage: { ...result.usage, provider: 'fixture-llm', requestedModel: 'fixture-model' },
    },
  });
});

test('invalid judgments are rejected instead of being coerced into accepted answers', async () => {
  for (const answers of [
    { cause: 'publish', needed: true, quality: 1 },
    { cause: 'environment', needed: 'yes', quality: 1 },
    { cause: 'environment', needed: true, quality: 99 },
    { cause: 'environment', needed: true },
  ]) {
    const provider = createLlmAssessmentProvider(config, async () => native(answers));
    await assert.rejects(
      provider.assess({
        state: {},
        questions,
        model: 'fixture-model',
        apiKey: 'fixture-key-only',
        signal: new AbortController().signal,
      }),
    );
  }
});

test('legacy probability-only answers retain vocabulary and boolean threshold behavior', () => {
  assert.deepEqual(
    assessmentChoiceOptions({
      type: 'choice',
      choice: 'yes',
      probabilities: { yes: 0.8, no: 0.2 },
    }),
    ['yes', 'no'],
  );
  assert.equal(assessmentBooleanValue({ type: 'boolean', probability: 0.6 }), false);
  assert.equal(assessmentBooleanValue({ type: 'boolean', value: true }), true);
});
