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
        model: 'jev-latest',
        answers: {
          risk: {
            type: 'choice',
            choice: 'unknown',
            probabilities: { low: 0.1, high: 0.9 },
          },
        },
        usage: { input_tokens: 321, output_tokens: 30 },
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
      (error: unknown) => {
        assert.ok(error instanceof AssessmentResponseError);
        assert.equal(error.attempted, true);
        assert.equal(error.usage?.inputTokens, 321);
        assert.equal(error.usage?.outputTokens, 30);
        assert.equal(error.returnedModel, 'jev-latest');
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test('TypeSafe adapter rejects malformed token counts without completing advice', async () => {
  const provider = createTypeSafeProvider(async () =>
    response({
      model: 'jev-1.13.0',
      answers: { risk: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: 70000.5, output_tokens: 30 },
    }),
  );
  await assert.rejects(
    provider.assess({
      state: 'synthetic risk',
      questions: { risk: { type: 'boolean', instructions: 'Is the risk present?' } },
      model: 'jev-1.13.0',
      apiKey: 'fixture-key',
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AssessmentResponseError);
      assert.equal(error.attempted, true);
      assert.equal(error.usage?.inputTokens, undefined);
      assert.equal(error.usage?.outputTokens, 30);
      assert.equal(error.returnedModel, 'jev-1.13.0');
      return true;
    },
  );
});

test('TypeSafe adapter rejects a completed reply without an input receipt and retains valid output usage', async () => {
  const provider = createTypeSafeProvider(async () =>
    response({
      model: 'jev-1.13.0',
      answers: { risk: { type: 'noul', noul: 0.9 } },
      usage: { output_tokens: 30 },
    }),
  );
  await assert.rejects(
    provider.assess({
      state: 'synthetic risk',
      questions: { risk: { type: 'boolean', instructions: 'Is the risk present?' } },
      model: 'jev-1.13.0',
      apiKey: 'fixture-key',
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AssessmentResponseError);
      assert.equal(error.attempted, true);
      assert.equal(error.responseReceived, true);
      assert.equal(error.httpStatus, undefined);
      assert.equal(error.usage?.inputTokens, undefined);
      assert.equal(error.usage?.outputTokens, 30);
      return true;
    },
  );
});

test('TypeSafe adapter retains HTTP error receipts without retrying', async () => {
  const cases: Array<{ status: number; body: unknown }> = [
    { status: 429, body: {} },
    { status: 503, body: { model: 'jev-1.13.0', usage: { input_tokens: 19, output_tokens: 7 } } },
  ];
  for (const { status, body } of cases) {
    let calls = 0;
    const provider = createTypeSafeProvider(async () => {
      calls++;
      return response(body, status);
    });
    await assert.rejects(
      provider.assess({
        state: 'synthetic risk',
        questions: { risk: { type: 'boolean', instructions: 'Is the risk present?' } },
        model: 'jev-1.13.0',
        apiKey: 'fixture-key',
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AssessmentResponseError);
        assert.equal(error.message, 'Assessment provider returned an HTTP error');
        assert.equal(error.attempted, true);
        assert.equal(error.responseReceived, true);
        assert.equal(error.httpStatus, status);
        assert.equal(error.usage?.inputTokens, status === 503 ? 19 : undefined);
        assert.equal(error.usage?.outputTokens, status === 503 ? 7 : undefined);
        assert.equal(typeof error.usage?.durationMs, 'number');
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test('TypeSafe adapter rejects absent or mismatched returned model identities', async () => {
  for (const returnedModel of [undefined, 'other-model']) {
    const provider = createTypeSafeProvider(async () =>
      response({
        ...(returnedModel === undefined ? {} : { model: returnedModel }),
        answers: { risk: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 19, output_tokens: 7 },
      }),
    );
    await assert.rejects(
      provider.assess({
        state: 'synthetic risk',
        questions: { risk: { type: 'boolean', instructions: 'Is the risk present?' } },
        model: 'jev-1.13.0',
        apiKey: 'fixture-key',
        signal: new AbortController().signal,
      }),
      (error: unknown) => {
        assert.ok(error instanceof AssessmentResponseError);
        assert.equal(error.responseReceived, true);
        assert.equal(error.returnedModel, returnedModel);
        assert.equal(error.usage?.inputTokens, 19);
        return true;
      },
    );
  }
});

test('TypeSafe adapter retains a receipt when a successful HTTP body fails to read', async () => {
  const provider = createTypeSafeProvider(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('synthetic body failure'));
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'application/json', 'x-typesafe-request-id': 'read-failure' },
    });
  });
  await assert.rejects(
    provider.assess({
      state: 'synthetic risk',
      questions: { risk: { type: 'boolean', instructions: 'Is the risk present?' } },
      model: 'jev-1.13.0',
      apiKey: 'fixture-key',
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AssessmentResponseError);
      assert.equal(error.responseReceived, true);
      assert.equal(error.httpStatus, 200);
      assert.equal(error.usage?.requestId, 'read-failure');
      return true;
    },
  );
});
