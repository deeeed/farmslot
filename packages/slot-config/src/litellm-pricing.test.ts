import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadLiteLlmPrices, parseLiteLlmPrices } from './litellm-pricing.js';
import { readPiAssistantUsage } from './session-usage.js';

const payload = {
  data: [
    {
      model_name: 'fixture-sonnet',
      model_info: {
        input_cost_per_token: 0.000002,
        output_cost_per_token: 0.00001,
        cache_read_input_token_cost: 0.0000002,
        cache_creation_input_token_cost: 0.0000025,
      },
    },
    { model_name: 'unpriced', model_info: {} },
  ],
};

test('model/info prices compute every token category without trusting SDK placeholder cost', () => {
  const prices = parseLiteLlmPrices(payload);
  const message = {
    type: 'message',
    message: {
      role: 'assistant',
      provider: 'litellm',
      model: 'fixture-sonnet',
      usage: {
        input: 100,
        output: 20,
        cacheRead: 10000,
        cacheWrite: 5000,
        cost: { total: 0 },
      },
    },
  };
  const result = readPiAssistantUsage(message, undefined, prices);
  assert.equal(result?.costUsd, 0.0149);
  assert.equal(
    readPiAssistantUsage(
      { ...message, message: { ...message.message, model: 'unpriced' } },
      undefined,
      prices,
    )?.costUsd,
    null,
  );
  assert.equal(
    parseLiteLlmPrices({
      data: [{ model_name: 'bad', model_info: { input_cost_per_token: -1 } }],
    }).get('bad')?.input,
    null,
  );
  const incomplete = parseLiteLlmPrices({
    data: [{ model_name: 'fixture-sonnet', model_info: { input_cost_per_token: 0.000002 } }],
  });
  assert.equal(readPiAssistantUsage(message, undefined, incomplete)?.costUsd, null);
});

test('prices persist across calls, refresh daily, and never persist credentials', async (t) => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'litellm-prices-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  let calls = 0;
  let now = 100000000;
  const options = {
    baseUrl: 'https://prices.example/v1',
    apiKey: 'fixture-secret',
    cacheDir,
    now: () => now,
    fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      assert.equal(url, 'https://prices.example/v1/model/info');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-secret');
      return Response.json(payload);
    },
  };
  assert.equal((await loadLiteLlmPrices(options)).get('fixture-sonnet')?.input, 2);
  await loadLiteLlmPrices(options);
  assert.equal(calls, 1);
  now += 86400000;
  await loadLiteLlmPrices(options);
  assert.equal(calls, 2);
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(cacheDir);
  assert.equal(files.length, 1);
  assert.doesNotMatch(await readFile(path.join(cacheDir, files[0]), 'utf8'), /fixture-secret/);
  now += 86400000;
  assert.equal(
    (
      await loadLiteLlmPrices({
        ...options,
        fetchImpl: async () => new Response('', { status: 503 }),
      })
    ).size,
    0,
  );
});

test('session extraction computes a precise LiteLLM total and marks local sessions unpriced', async (t) => {
  const { writeFile } = await import('node:fs/promises');
  const { runSessionUsage } = await import('./session-usage.js');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'litellm-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.LITELLM_URL = 'https://prices.example/v1';
  process.env.LITELLM_API_KEY = 'fixture-secret';
  process.env.FARMSLOT_LITELLM_PRICING_CACHE_DIR = directory;
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
  const file = path.join(directory, 'session.jsonl');
  const message = {
    type: 'message',
    message: {
      role: 'assistant',
      provider: 'litellm',
      model: 'fixture-sonnet',
      usage: {
        input: 4,
        output: 4,
        cacheRead: 38195,
        cacheWrite: 0,
        cost: { total: 0 },
      },
    },
  };
  const read = () =>
    runSessionUsage({
      repo: '',
      slotId: 'synthetic',
      action: 'total',
      forcedRunner: 'pi',
      forcedPath: file,
    });
  await writeFile(file, JSON.stringify(message) + '\n');
  assert.match(await read(), /cost_usd=0\.0076870000\n/);
  await writeFile(
    file,
    JSON.stringify({ ...message, message: { ...message.message, provider: 'ollama' } }) + '\n',
  );
  const local = await read();
  assert.doesNotMatch(local, /cost_usd=/);
  assert.match(local, /cost_reason=local, unpriced/);
  await writeFile(
    file,
    [message, { ...message, message: { ...message.message, model: 'unpriced' } }]
      .map((row) => JSON.stringify(row))
      .join('\n'),
  );
  const partial = await read();
  assert.doesNotMatch(partial, /cost_usd=/);
  assert.match(partial, /cost_reason=/);
});

test('gateway context tiers and one-hour cache-write rates keep their units', () => {
  const prices = parseLiteLlmPrices({
    data: [
      {
        model_name: 'fixture-tiered',
        model_info: {
          ...payload.data[0].model_info,
          input_cost_per_token_above_200k_tokens: '0.000004',
          cache_creation_input_token_cost_above_1hr: 0.000004,
        },
      },
    ],
  });
  const record = (usage: Record<string, number>) => ({
    type: 'message',
    message: { role: 'assistant', provider: 'litellm', model: 'fixture-tiered', usage },
  });
  assert.equal(
    readPiAssistantUsage(record({ input: 200001, output: 10 }), undefined, prices)?.costUsd,
    0.800104,
  );
  assert.equal(
    readPiAssistantUsage(
      record({ input: 4, output: 4, cacheWrite: 100, cacheWrite1h: 100 }),
      undefined,
      prices,
    )?.costUsd,
    0.000448,
  );
});
