import assert from 'node:assert/strict';
import test from 'node:test';

import { AssessmentResponseError } from './provider.js';
import { createTypeSafeProvider } from './typesafe.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req-test' },
  });
}

test('TypeSafe adapter maps boolean questions to noul and validates typed answers', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  let captured: Record<string, unknown> | undefined;
  try {
    const provider = createTypeSafeProvider(async (_input, init) => {
      captured = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response({
        model: 'jev-1.13.0',
        answers: { visual: { type: 'noul', noul: 0.82 } },
        usage: { input_tokens: 12, output_tokens: 4 },
      });
    });
    const result = await provider.assess({
      state: { diff: 'changed button label' },
      questions: {
        visual: { type: 'boolean', instructions: 'Does this require visual review?' },
      },
      model: 'jev-1.13.0',
      apiKey: 'test-key',
      signal: new AbortController().signal,
    });
    assert.equal(result.returnedModel, 'jev-1.13.0');
    assert.equal(result.answers.visual?.type, 'boolean');
    assert.equal(result.answers.visual?.probability, 0.82);
    assert.deepEqual((captured?.questions as Record<string, unknown>)?.visual, {
      type: 'noul',
      instructions: 'Does this require visual review?',
    });
    assert.equal(result.usage.inputTokens, 12);
    assert.equal(result.usage.outputTokens, 4);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('TypeSafe adapter rejects an answer outside the declared choice set', async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'test-key';
  try {
    const provider = createTypeSafeProvider(async () =>
      response({
        answers: {
          risk: {
            type: 'choice',
            choice: 'unknown',
            probabilities: { low: 0.1, high: 0.9 },
          },
        },
      }),
    );
    await assert.rejects(
      provider.assess({
        state: 'diff',
        questions: {
          risk: {
            type: 'choice',
            instructions: 'What is the risk?',
            criteria: { low: 'low risk', high: 'high risk' },
          },
        },
        model: 'jev-latest',
        apiKey: 'test-key',
        signal: new AbortController().signal,
      }),
      AssessmentResponseError,
    );
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});
