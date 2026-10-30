import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  checkPiProviderAuth,
  deadlinePiFetch,
  fetchOpenAiModelIds,
  listPiProviderSources,
  openaiBaseUrl,
  resolvePiProviderCatalog,
} from './pi-farmslot-providers.mjs';

function hangingFetch(_input, { signal }) {
  return Promise.resolve(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
          signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    ),
  );
}

test('two consecutive deadlines exhaust one retry and a new turn resets the budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let operator = new AbortController();
  let aborts = 0;
  const fetch = deadlinePiFetch(hangingFetch, 100, () => {
    aborts++;
    operator.abort();
  });
  const request = async () => {
    const response = await fetch('http://fixture', { signal: operator.signal });
    const rejected = assert.rejects(response.text());
    t.mock.timers.tick(100);
    await rejected;
  };
  await request();
  assert.equal(aborts, 0);
  await request();
  assert.equal(aborts, 1);
  fetch.reset();
  operator = new AbortController();
  await request();
  assert.equal(aborts, 1);
  const response = await fetch('http://fixture', { signal: operator.signal });
  const cancelled = assert.rejects(response.text(), { name: 'AbortError' });
  operator.abort();
  await cancelled;
  t.mock.timers.tick(100);
  assert.equal(aborts, 1);
});

test('a request that never receives headers has the same bounded deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetch = deadlinePiFetch(
    (_input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  const rejected = assert.rejects(fetch('http://fixture'), /timed out after 300000ms/);
  t.mock.timers.tick(300_000);
  await rejected;
});

test('a provider response that opened but never ends gets a retryable timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const operator = new AbortController();
  t.after(() => operator.abort());
  const response = await deadlinePiFetch(hangingFetch)('http://fixture', {
    signal: operator.signal,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const body = response.text();
  const rejection = assert.rejects(body, /Pi model request timed out after 300000ms/);
  t.mock.timers.tick(300_000);
  await rejection;
  assert.equal(operator.signal.aborted, false);
});

test('operator cancellation stays cancelled and healthy responses clear their deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const operator = new AbortController();
  const response = await deadlinePiFetch(hangingFetch)('http://fixture', {
    signal: operator.signal,
  });
  const cancelled = assert.rejects(response.text(), { name: 'AbortError' });
  operator.abort();
  await cancelled;
  let requestSignal;
  const healthy = await deadlinePiFetch(async (_input, options) => {
    requestSignal = options.signal;
    return new Response('OK');
  })('http://fixture');
  assert.equal(await healthy.text(), 'OK');
  t.mock.timers.tick(300_000);
  assert.equal(requestSignal.aborted, false);
});

test('extension-provider preflight uses live authenticated model discovery without inference', async (t) => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder' }] }));
  });
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await checkPiProviderAuth('unused-native-cli', 'ollama/qwen2.5-coder', {
    FARMSLOT_PI_OLLAMA_URL: `http://127.0.0.1:${address.port}`,
    OLLAMA_API_KEY: 'fixture-key',
  });
  assert.deepEqual(result, { status: 'ready', provider: 'ollama' });
  assert.equal(requests, 1);
});

test('openaiBaseUrl adds http and /v1', () => {
  assert.equal(openaiBaseUrl('127.0.0.1:11434'), 'http://127.0.0.1:11434/v1');
  assert.equal(openaiBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(openaiBaseUrl('http://127.0.0.1:4000'), 'http://127.0.0.1:4000/v1');
});

test('listPiProviderSources includes default Ollama unless disabled', () => {
  const sources = listPiProviderSources({});
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'ollama');
  assert.equal(sources[0].baseUrl, 'http://127.0.0.1:11434/v1');
  assert.deepEqual(listPiProviderSources({ FARMSLOT_PI_OLLAMA: '0' }), []);
});

test('listPiProviderSources adds LiteLLM and a distinct custom router', () => {
  const sources = listPiProviderSources({
    FARMSLOT_PI_OLLAMA: '0',
    LITELLM_URL: 'http://127.0.0.1:4000',
    LITELLM_API_KEY: 'sk-litellm',
    FARMSLOT_PI_ROUTER_URL: 'http://127.0.0.1:9000/v1',
    FARMSLOT_PI_ROUTER_KEY: 'sk-router',
  });
  assert.deepEqual(
    sources.map((source) => [source.id, source.baseUrl, source.apiKey]),
    [
      ['litellm', 'http://127.0.0.1:4000/v1', 'sk-litellm'],
      ['router', 'http://127.0.0.1:9000/v1', 'sk-router'],
    ],
  );
});

test('resolvePiProviderCatalog registers fetched models and skips empty endpoints', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('11434')) {
      return {
        ok: true,
        json: async () => ({ data: [{ id: 'qwen2.5-coder' }, { id: 'qwen3' }] }),
      };
    }
    return { ok: false, json: async () => ({}) };
  };
  const catalog = await resolvePiProviderCatalog({ OLLAMA_HOST: '127.0.0.1:11434' }, { fetchImpl });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].id, 'ollama');
  assert.deepEqual(
    catalog[0].models.map((model) => model.id),
    ['qwen2.5-coder', 'qwen3'],
  );
});

test('fetchOpenAiModelIds returns empty on timeout or throw', async () => {
  const ids = await fetchOpenAiModelIds('http://127.0.0.1:9/v1', 'k', {
    fetchImpl: async () => {
      throw new Error('down');
    },
  });
  assert.deepEqual(ids, []);
});
