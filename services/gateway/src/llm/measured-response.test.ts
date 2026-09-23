import assert from 'node:assert/strict';
import test from 'node:test';

import { type MeasuredResponseOptions, measuredResponsesCall } from './measured-response.js';

const options: MeasuredResponseOptions = {
  baseUrl: 'http://127.0.0.1:2455/v1',
  apiKey: 'synthetic-only-api-key',
  model: 'answer-model-v1',
  instructions: 'Return JSON',
  prompt: 'Synthetic question',
  maxOutputTokens: 128,
  reasoning: 'low',
};
const response = {
  id: 'resp_fixture',
  status: 'completed',
  model: 'answer-model-v1',
  usage: {
    input_tokens: 100,
    output_tokens: 8,
    input_tokens_details: { cached_tokens: 60, cache_write_tokens: 10 },
  },
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '{"answer":["OK"]}' }],
    },
  ],
};

test('one request preserves native returned identity and cache-inclusive usage', async () => {
  let calls = 0;
  const transport: typeof fetch = async (_url, init) => {
    calls++;
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.max_output_tokens, 128);
    assert.equal(sent.reasoning.effort, 'low');
    assert.equal(sent.store, false);
    assert.deepEqual(sent.tools, []);
    return new Response(
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const result = await measuredResponsesCall(options, transport);
  assert.equal(calls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.returnedModel, 'answer-model-v1');
  assert.equal(result.inputTokens, 100);
  assert.equal(result.cacheReadTokens, 60);
  assert.equal(result.cacheWriteTokens, 10);
  assert.equal(result.inputAccounting, 'includes-cache');
  assert.equal(result.responseReceived, true);
  assert.equal(result.httpStatus, 200);
  assert.match(result.receiptHash!, /^[a-f0-9]{64}$/);
});

test('received HTTP failures never retry or fabricate zero usage', async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    const result = await measuredResponsesCall(options, async () => {
      calls++;
      return new Response('temporary provider failure', { status });
    });
    assert.equal(calls, 1);
    assert.equal(result.attempted, true);
    assert.equal(result.responseReceived, true);
    assert.equal(result.httpStatus, status);
    assert.equal(result.inputTokens, null);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.error, 'provider-http-error');
  }
});

test('terminal usage survives a malformed later SSE frame without accepting its answer', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
        ),
      );
      controller.enqueue(encoder.encode('event: response.failed\ndata: {invalid}\n\n'));
      controller.close();
    },
  });
  const result = await measuredResponsesCall(
    options,
    async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.text, undefined);
  assert.equal(result.attempted, true);
  assert.equal(result.responseReceived, true);
  assert.equal(result.responseId, 'resp_fixture');
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 8);
  assert.equal(result.cacheReadTokens, 60);
});

test('a malformed first SSE frame retains the HTTP response receipt before a body hash exists', async () => {
  const result = await measuredResponsesCall(
    options,
    async () =>
      new Response('event: response.failed\ndata: {invalid}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.attempted, true);
  assert.equal(result.responseReceived, true);
  assert.equal(result.receiptHash, undefined);
  assert.equal(result.inputTokens, null);
});

test('an abort after response headers retains the HTTP receipt', async () => {
  const controller = new AbortController();
  const resultPromise = measuredResponsesCall(
    { ...options, signal: controller.signal },
    async () =>
      new Response(new ReadableStream<Uint8Array>({ pull() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      }),
  );
  setTimeout(() => controller.abort(new Error('synthetic timeout')), 0);
  const result = await resultPromise;
  assert.equal(result.status, 'unavailable');
  assert.equal(result.responseReceived, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.error, 'request-timed-out-or-cancelled');
});

test('terminal usage survives a read failure after receipt', async () => {
  let read = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!read) {
        read = true;
        controller.enqueue(
          new TextEncoder().encode(
            `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
          ),
        );
        return;
      }
      controller.error(new Error('connection closed'));
    },
  });
  const result = await measuredResponsesCall(
    options,
    async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(result.text, undefined);
  assert.equal(result.inputTokens, 100);
  assert.equal(result.outputTokens, 8);
});

test('model mismatches, tool calls and credential echoes cannot become answers', async () => {
  for (const payload of [
    { ...response, model: 'other-model' },
    { ...response, output: [{ type: 'function_call', name: 'publish' }] },
    {
      ...response,
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: options.apiKey }],
        },
      ],
    },
  ]) {
    const result = await measuredResponsesCall(
      options,
      async () =>
        new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } }),
    );
    assert.equal(result.status, 'unavailable');
    assert.equal(result.text, undefined);
    assert.equal(JSON.stringify(result).includes(options.apiKey), false);
  }
});
