import assert from 'node:assert/strict';
import test from 'node:test';

import { createModels } from '@earendil-works/pi-ai';

import { resolveAuth } from './auth-resolve.js';
import { reportedLlmCost } from './codex-astra.js';
import { CODEX_LB_BASE_URL, registerCodexLb } from './codex-lb.js';
import { llmDefaultsForProvider } from './config.js';
import { callLLM, callLLMChat } from './index.js';

test('explicit LB provider sends Responses requests only to loopback with client-key auth', async (t) => {
  const models = createModels();
  registerCodexLb(models);
  const provider = models.getProvider('codex-lb')!;
  assert.equal(provider.auth.oauth, undefined);
  assert.ok(provider.auth.apiKey);
  const model = models.getModel('codex-lb', 'gpt-6-astra')!;
  assert.equal(model.api, 'openai-responses');
  assert.equal(model.baseUrl, CODEX_LB_BASE_URL);
  const fetch = globalThis.fetch;
  const seen: { url: string; authorization: string | null; body: Record<string, any> }[] = [];
  t.after(() => {
    globalThis.fetch = fetch;
  });
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push({
      url: request.url,
      authorization: request.headers.get('authorization'),
      body: (await request.json()) as Record<string, any>,
    });
    return new Response(JSON.stringify({ error: { message: 'unit request observed' } }), {
      status: 418,
      headers: { 'content-type': 'application/json' },
    });
  };
  const result = await models.completeSimple(
    model,
    {
      systemPrompt: 'Reply briefly',
      messages: [{ role: 'user', content: 'OK', timestamp: Date.now() }],
    },
    { apiKey: 'unit-lb-client-key', reasoning: 'low', maxTokens: 16, maxRetries: 0 },
  );
  assert.equal(result.stopReason, 'error');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${CODEX_LB_BASE_URL}/responses`);
  assert.equal(seen[0].authorization, 'Bearer unit-lb-client-key');
  assert.equal(seen[0].body.model, 'gpt-6-astra');
  assert.equal(seen[0].body.reasoning.effort, 'low');
  assert.equal(seen[0].body.max_output_tokens, 16);
  assert.equal(seen[0].body.store, false);
  assert.equal(seen[0].body.tools, undefined);
  assert.equal(reportedLlmCost('codex-lb', 0.3), undefined);
  registerCodexLb(models);
  assert.equal(models.getProvider('codex-lb'), provider);
});

test('LB auth is env-only and missing key never becomes upstream OAuth or CLI fallback', async (t) => {
  const before = process.env.CODEX_LB_API_KEY;
  t.after(() => {
    if (before === undefined) delete process.env.CODEX_LB_API_KEY;
    else process.env.CODEX_LB_API_KEY = before;
  });
  process.env.CODEX_LB_API_KEY = 'unit-explicit-client-key';
  assert.deepEqual(await resolveAuth('codex-lb'), {
    apiKey: 'unit-explicit-client-key',
    source: 'env:CODEX_LB_API_KEY',
  });
  delete process.env.CODEX_LB_API_KEY;
  assert.equal(await resolveAuth('codex-lb'), null);
  await assert.rejects(
    callLLM({ provider: 'codex-lb', model: 'standard', userPrompt: 'OK' }),
    /CLI fallback disabled/,
  );
  await assert.rejects(
    callLLMChat({
      provider: 'codex-lb',
      model: 'standard',
      messages: [{ role: 'user', content: 'OK' }],
    }),
    /CLI fallback disabled/,
  );
  assert.equal(llmDefaultsForProvider('codex-lb').intelligenceModel, 'gpt-6-astra');
  assert.equal(llmDefaultsForProvider('codex-lb').intelligenceEffort, 'low');
});
