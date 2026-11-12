import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  checkPiProviderAuth,
  deadlinePiFetch,
  fetchOpenAiModels,
  listPiProviderSources,
  openaiBaseUrl,
  PiProviderConfigurationError,
  piSdkModels,
  providerReasoningFetch,
  resolvePiProviderCatalog,
  unavailablePiAuth,
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

test('renamed router auth accepts the legacy model through the helper and CLI', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, 'Bearer fixture-key');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'GLM-5.3-Flash-s12' }] }));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const env = {
    FARMSLOT_PI_OLLAMA: '0',
    FARMSLOT_PI_ROUTER_ID: 'localsparks',
    FARMSLOT_PI_ROUTER_URL: `http://127.0.0.1:${address.port}`,
    FARMSLOT_PI_ROUTER_KEY: 'fixture-key',
  };
  for (const provider of ['router', 'localsparks']) {
    const model = `${provider}/GLM-5.3-Flash-s12`;
    assert.deepEqual(await checkPiProviderAuth('/synthetic/missing-pi', model, env), {
      status: 'ready',
      provider,
    });
    const child = spawn(
      process.execPath,
      [
        new URL('./pi-farmslot-providers.mjs', import.meta.url).pathname,
        '/synthetic/missing-pi',
        model,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output), { status: 'ready', provider });
  }
  assert.notEqual(
    (await checkPiProviderAuth('/synthetic/missing-pi', 'router/missing', env)).status,
    'ready',
  );
});

test('a native check without a verdict names its cause and never passes its output on', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-auth-cause-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = (name, body) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  };
  for (const [binary, expected] of [
    [join(dir, 'missing'), { cause: 'not_found' }],
    [runner('failed', 'echo secret-token; exit 3'), { cause: 'failed', exitCode: 3 }],
    [runner('silent', 'echo secret-token'), { cause: 'no_verdict', exitCode: 0 }],
  ])
    assert.deepEqual(
      await checkPiProviderAuth(binary, 'anthropic/claude-haiku-4-5', { FARMSLOT_PI_OLLAMA: '0' }),
      { status: 'invalid', reason: 'auth_check_unavailable', ...expected },
    );
});

test('each spawnSync failure shape maps to its cause', () => {
  const unavailable = { status: 'invalid', reason: 'auth_check_unavailable' };
  for (const [result, expected] of [
    // What spawnSync returns when its timeout kills the child.
    [{ error: { code: 'ETIMEDOUT' }, status: null, signal: 'SIGTERM' }, { cause: 'timeout' }],
    [{ error: { code: 'ENOENT' }, status: null, signal: null }, { cause: 'not_found' }],
    [
      { status: null, signal: 'SIGKILL' },
      { cause: 'failed', signal: 'SIGKILL' },
    ],
    [
      { status: 3, signal: null },
      { cause: 'failed', exitCode: 3 },
    ],
    [
      { status: 0, signal: null },
      { cause: 'no_verdict', exitCode: 0 },
    ],
  ])
    assert.deepEqual(unavailablePiAuth(result), { ...unavailable, ...expected });
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

test('router id validation rejects malformed and reserved provider ids', () => {
  for (const id of [
    '',
    'LocalSparks',
    'has space',
    'router/model',
    '-leading',
    'trailing-',
    'litellm',
    'ollama',
    'lmstudio',
    'omlx',
    'xai',
    'anthropic',
    'openai',
    'azure-openai-responses',
  ])
    assert.throws(() => listPiProviderSources({ FARMSLOT_PI_ROUTER_ID: id }), {
      name: 'Error',
      message: /FARMSLOT_PI_ROUTER_ID/,
    });
  for (const id of ['localsparks', 'local-sparks', 'local_sparks', 'local.sparks'])
    assert.equal(
      listPiProviderSources({
        FARMSLOT_PI_OLLAMA: '0',
        FARMSLOT_PI_ROUTER_URL: 'http://router.test',
        FARMSLOT_PI_ROUTER_ID: id,
      })[0].id,
      id,
    );
});

test('configured router keeps its source kind, limits, reasoning and hidden alias names', async () => {
  const [provider] = await resolvePiProviderCatalog(
    {
      FARMSLOT_PI_OLLAMA: '0',
      FARMSLOT_PI_ROUTER_URL: 'http://router.test',
      FARMSLOT_PI_ROUTER_ID: 'localsparks',
      FARMSLOT_PI_ROUTER_CONTEXT: '65536',
      FARMSLOT_PI_ROUTER_MAX_TOKENS: '4096',
      FARMSLOT_PI_ROUTER_MODEL_LIMITS: JSON.stringify({ 'GLM-5.3-Flash-s12': { maxTokens: 2048 } }),
    },
    { fetchImpl: modelsFetch({ id: 'GLM-5.3-Flash-s12' }) },
  );
  assert.equal(provider.id, 'localsparks');
  assert.equal(provider.kind, 'router');
  assert.deepEqual(provider.aliases, ['router']);
  const model = provider.models[0];
  assert.equal(model.contextWindow, 65536);
  assert.equal(model.maxTokens, 2048);
  assert.equal(model.reasoning, true);
  assert.equal(model.thinkingLevelMap.max, 'max');
  await assert.rejects(
    resolvePiProviderCatalog(
      {
        FARMSLOT_PI_OLLAMA: '0',
        FARMSLOT_PI_ROUTER_URL: 'http://router.test',
        FARMSLOT_PI_ROUTER_ID: 'localsparks',
        FARMSLOT_PI_ROUTER_REASONING: 'false',
      },
      { fetchImpl: modelsFetch({ id: 'model' }) },
    ),
    /requires reasoning/,
  );
  const fetch = providerReasoningFetch(async () => new Response('OK'), [provider]);
  await assert.rejects(
    fetch('http://router.test/v1/chat/completions', {
      body: JSON.stringify({ model: model.id, reasoning_effort: 'none' }),
    }),
    /requires a reasoning effort/,
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

test('fetchOpenAiModels returns empty on timeout or throw', async () => {
  const ids = await fetchOpenAiModels('http://127.0.0.1:9/v1', 'k', {
    fetchImpl: async () => {
      throw new Error('down');
    },
  });
  assert.deepEqual(ids, []);
});

test('router discovery keeps a server-reported 1M context and output budget', async () => {
  const [provider] = await resolvePiProviderCatalog(
    {
      FARMSLOT_PI_OLLAMA: '0',
      FARMSLOT_PI_ROUTER_URL: 'http://router.test/v1',
    },
    {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'DeepSeek-V4.1-Flash-1017',
              context_length: 1_048_576,
              max_output_tokens: 32_768,
            },
          ],
        }),
      }),
    },
  );
  assert.equal(provider.models[0].contextWindow, 1_048_576);
  assert.equal(provider.models[0].maxTokens, 32_768);
  assert.equal(provider.models[0].reasoning, true);
});

test('router model definitions preserve xhigh and max instead of letting Pi round them down', async () => {
  const [provider] = await resolvePiProviderCatalog(
    { FARMSLOT_PI_OLLAMA: '0', FARMSLOT_PI_ROUTER_URL: 'http://router.test/v1' },
    { fetchImpl: modelsFetch({ id: 'DeepSeek-V4.1-Flash-1017', supports_reasoning: true }) },
  );
  assert.equal(provider.models[0].thinkingLevelMap?.xhigh, 'xhigh');
  assert.equal(provider.models[0].thinkingLevelMap?.max, 'max');
  const [other] = await resolvePiProviderCatalog({}, { fetchImpl: modelsFetch({ id: 'local' }) });
  assert.equal(other.models[0].thinkingLevelMap, undefined);
});

test('all worker provider models declare image input without per-model detection', async () => {
  const providers = await resolvePiProviderCatalog(
    { LITELLM_URL: 'http://litellm.test/v1', FARMSLOT_PI_ROUTER_URL: 'http://router.test/v1' },
    { fetchImpl: modelsFetch({ id: 'DeepSeek-V4.1-Flash-1017', supports_reasoning: true }) },
  );
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ['ollama', 'litellm', 'router'],
  );
  for (const provider of providers)
    assert.deepEqual(provider.models[0].input, ['text', 'image'], provider.id);
});

test('id-only router discovery uses configured limits and defaults reasoning on', async () => {
  const [provider] = await resolvePiProviderCatalog(
    {
      FARMSLOT_PI_OLLAMA: '0',
      FARMSLOT_PI_ROUTER_URL: 'http://router.test/v1',
      FARMSLOT_PI_ROUTER_CONTEXT: '1048576',
      FARMSLOT_PI_ROUTER_MAX_TOKENS: '32768',
    },
    {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ data: [{ id: 'DeepSeek-V4.1-Flash-1017' }] }),
      }),
    },
  );
  assert.equal(provider.models[0].contextWindow, 1_048_576);
  assert.equal(provider.models[0].maxTokens, 32_768);
  assert.equal(provider.models[0].reasoning, true);
});

const routerEnv = { FARMSLOT_PI_OLLAMA: '0', FARMSLOT_PI_ROUTER_URL: 'http://router.test/v1' };
const modelsFetch = (row) => async () => ({ ok: true, json: async () => ({ data: [row] }) });

test('router reasoning object with default_enabled true registers a reasoning model', async () => {
  const [provider] = await resolvePiProviderCatalog(routerEnv, {
    fetchImpl: modelsFetch({
      id: 'model',
      reasoning: { default_enabled: true, effort_levels: ['low', 'medium', 'high'] },
    }),
  });
  assert.equal(provider.id, 'router');
  assert.equal(provider.models[0].id, 'model');
  assert.equal(provider.models[0].reasoning, true);
});

test('router reasoning object with default_enabled false requires reasoning like false', async () => {
  for (const reasoning of [false, { default_enabled: false }])
    await assert.rejects(
      resolvePiProviderCatalog(routerEnv, {
        fetchImpl: modelsFetch({ id: 'model', reasoning }),
      }),
      {
        name: 'Error',
        message: 'Model router/model requires reasoning for code work',
      },
    );
});

test('router reasoning object without a boolean default_enabled keeps the existing error', async () => {
  for (const reasoning of [
    {},
    { effort_levels: ['low', 'high'] },
    { default_enabled: 'true' },
    { default_enabled: 'false' },
    { default_enabled: 1 },
    { default_enabled: 0 },
    { default_enabled: null },
    [],
  ])
    await assert.rejects(
      resolvePiProviderCatalog(routerEnv, {
        fetchImpl: modelsFetch({ id: 'model', reasoning }),
      }),
      {
        name: 'Error',
        message: 'router/model reasoning must be true, false, 1 or 0',
      },
    );
});

test('endpoint metadata takes precedence and source configuration only fills missing fields', async () => {
  for (const contextField of [
    'context_length',
    'max_model_len',
    'context_window',
    'contextWindow',
  ]) {
    const [provider] = await resolvePiProviderCatalog(
      {
        ...routerEnv,
        FARMSLOT_PI_ROUTER_CONTEXT: '128000',
        FARMSLOT_PI_ROUTER_MAX_TOKENS: '16384',
      },
      {
        fetchImpl: modelsFetch({
          id: 'model',
          [contextField]: 1_048_576,
          max_output_tokens: 32768,
        }),
      },
    );
    assert.equal(provider.models[0].contextWindow, 1_048_576);
    assert.equal(provider.models[0].maxTokens, 32768);
  }
  for (const outputField of [
    'max_output_tokens',
    'max_completion_tokens',
    'max_tokens',
    'maxTokens',
  ]) {
    const [provider] = await resolvePiProviderCatalog(routerEnv, {
      fetchImpl: modelsFetch({ id: 'model', [outputField]: 65536 }),
    });
    assert.equal(provider.models[0].maxTokens, 65536);
  }
});

test('unknown limits retain defaults and LiteLLM/Ollama can configure the same fields', async () => {
  const [unknown] = await resolvePiProviderCatalog({}, { fetchImpl: modelsFetch({ id: 'model' }) });
  assert.equal(unknown.models[0].contextWindow, 128000);
  assert.equal(unknown.models[0].maxTokens, 8192);
  assert.equal(unknown.models[0].reasoning, false);
  for (const source of ['OLLAMA', 'LITELLM']) {
    const env =
      source === 'OLLAMA' ? {} : { FARMSLOT_PI_OLLAMA: '0', LITELLM_URL: 'http://litellm.test' };
    const [provider] = await resolvePiProviderCatalog(
      {
        ...env,
        [`FARMSLOT_PI_${source}_CONTEXT`]: '1048576',
        [`FARMSLOT_PI_${source}_MAX_TOKENS`]: '32768',
        [`FARMSLOT_PI_${source}_REASONING`]: 'true',
      },
      { fetchImpl: modelsFetch({ id: 'model' }) },
    );
    assert.equal(provider.models[0].contextWindow, 1_048_576);
    assert.equal(provider.models[0].maxTokens, 32768);
    assert.equal(provider.models[0].reasoning, true);
  }
});

test('invalid configured or reported limits refuse instead of using defaults', async () => {
  for (const value of ['0', '-1', '1.5', '1e6', '9007199254740992', 'bad', '']) {
    for (const key of ['FARMSLOT_PI_ROUTER_CONTEXT', 'FARMSLOT_PI_ROUTER_MAX_TOKENS'])
      await assert.rejects(
        resolvePiProviderCatalog(
          { ...routerEnv, [key]: value },
          {
            fetchImpl: modelsFetch({ id: 'model' }),
          },
        ),
        { name: 'Error', message: `${key} must be a positive safe integer` },
      );
  }
  for (const row of [
    { context_length: 'bad' },
    { max_output_tokens: -1 },
    { max_model_len: [1] },
    { reasoning: 'maybe' },
  ])
    await assert.rejects(
      resolvePiProviderCatalog(routerEnv, {
        fetchImpl: modelsFetch({ id: 'model', ...row }),
      }),
      PiProviderConfigurationError,
      piSdkModels,
    );
  await assert.rejects(
    resolvePiProviderCatalog(
      { ...routerEnv, FARMSLOT_PI_ROUTER_REASONING: 'maybe' },
      {
        fetchImpl: modelsFetch({ id: 'model' }),
      },
    ),
    PiProviderConfigurationError,
    piSdkModels,
  );
});

test('router models cannot silently register as non-reasoning', async () => {
  for (const [env, row] of [
    [{ ...routerEnv, FARMSLOT_PI_ROUTER_REASONING: 'false' }, { id: 'model' }],
    [routerEnv, { id: 'model', supports_reasoning: false }],
  ])
    await assert.rejects(
      resolvePiProviderCatalog(env, { fetchImpl: modelsFetch(row) }),
      /requires reasoning/,
    );
});

test('router wire guard permits absent thinking and refuses invalid explicit effort', async () => {
  const [router] = await resolvePiProviderCatalog(
    {
      ...routerEnv,
      FARMSLOT_PI_ROUTER_CONTEXT: '1048576',
      FARMSLOT_PI_ROUTER_MAX_TOKENS: '32768',
    },
    { fetchImpl: modelsFetch({ id: 'DeepSeek-V4.1-Flash-1017' }) },
  );
  let requests = 0;
  const records = [];
  const fetch = providerReasoningFetch(
    async (_input, options) => {
      requests++;
      assert.ok([undefined, 'medium'].includes(JSON.parse(options.body).reasoning_effort));
      return new Response('OK');
    },
    [router],
    (record) => records.push(record),
  );
  const body = { model: 'DeepSeek-V4.1-Flash-1017', reasoning_effort: 'medium', max_tokens: 32768 };
  assert.equal(
    await (
      await fetch('http://router.test/v1/chat/completions', { body: JSON.stringify(body) })
    ).text(),
    'OK',
  );
  assert.deepEqual(records, [
    {
      provider: 'router',
      model: body.model,
      contextWindow: 1048576,
      maxTokens: 32768,
      requestedMaxTokens: 32768,
      reasoning: true,
      effort: 'medium',
      cost: null,
    },
  ]);
  await fetch('http://router.test/v1/chat/completions', {
    body: JSON.stringify({ model: body.model }),
  });
  for (const effort of ['off', 'none', '']) {
    await assert.rejects(
      fetch('http://router.test/v1/chat/completions', {
        body: JSON.stringify({ ...body, reasoning_effort: effort }),
      }),
      /refusing a non-reasoning request/,
    );
  }
  assert.equal(requests, 2);
  assert.equal(records.length, 2);
});

function guardedRequest({ provider = 'litellm', thinking = 'max', model = {} } = {}) {
  const sent = [];
  const records = [];
  const fetch = providerReasoningFetch(
    async (input, options) => {
      sent.push({ input, options });
      return new Response('OK');
    },
    [
      {
        id: provider,
        baseUrl: 'http://provider.test/v1',
        models: [{ id: 'model', reasoning: true, input: ['text'], ...model }],
      },
    ],
    (record) => records.push(record),
    thinking,
  );
  const request = (payload) =>
    fetch('http://provider.test/v1/chat/completions', {
      body: JSON.stringify({ model: 'model', ...payload }),
    });
  return { fetch, request, sent, records };
}

test('wire guard refuses an undeclared max-to-high clamp before sending or recording', async () => {
  for (const provider of ['router', 'litellm', 'ollama']) {
    const { request, sent, records } = guardedRequest({ provider });
    await assert.rejects(request({ reasoning_effort: 'high' }), /PI_REASONING_EFFORT_MISMATCH/);
    assert.equal(sent.length, 0);
    assert.equal(records.length, 0);
    await request({ reasoning_effort: 'max' });
    assert.equal(sent.length, 1);
    assert.equal(records[0].effort, 'max');
  }
});

test('wire guard honors the model thinking map rather than requiring identical labels', async () => {
  const { request, sent } = guardedRequest({ model: { thinkingLevelMap: { max: 'high' } } });
  await request({ reasoning_effort: 'high' });
  await assert.rejects(request({ reasoning_effort: 'max' }), /PI_REASONING_EFFORT_MISMATCH/);
  assert.equal(sent.length, 1);
});

test('wire guard logs a selected effort mismatch once before refusing to send', async (t) => {
  const stderr = t.mock.method(console, 'error', () => {});
  const { request, sent } = guardedRequest({ thinking: 'medium', model: { reasoning: false } });
  await assert.rejects(
    request({ messages: ['fixture-private-body'] }),
    /PI_REASONING_EFFORT_MISMATCH/,
  );
  await assert.rejects(request({}), /PI_REASONING_EFFORT_MISMATCH/);
  assert.equal(stderr.mock.callCount(), 1);
  const message = stderr.mock.calls[0].arguments.join(' ');
  assert.match(message, /litellm\/model requested medium/);
  assert.match(message, /FARMSLOT_PI_LITELLM_MODEL_LIMITS/);
  assert.doesNotMatch(message, /fixture-private-body/);
  assert.equal(sent.length, 0);
  const disabled = guardedRequest({ thinking: 'off', model: { reasoning: false } });
  await disabled.request({});
  assert.equal(disabled.sent.length, 1);
});

test('router guard leaves other providers unchanged and accepts Request inputs', async () => {
  const [router] = await resolvePiProviderCatalog(routerEnv, {
    fetchImpl: modelsFetch({ id: 'model' }),
  });
  let requests = 0;
  const upstream = async () => {
    requests++;
    return new Response('OK');
  };
  const fetch = providerReasoningFetch(upstream, [router]);
  await fetch('http://native.test/v1/chat/completions', { body: 'unrelated' });
  await fetch(
    new Request('http://router.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'model', reasoning_effort: 'high' }),
    }),
  );
  assert.equal(requests, 2);
  assert.equal(providerReasoningFetch(upstream, undefined), upstream);
});

function modelInfoFetch(infos) {
  return async (url) => ({
    ok: true,
    json: async () => ({
      data: String(url).endsWith('/model/info')
        ? Object.entries(infos).map(([model_name, model_info]) => ({ model_name, model_info }))
        : Object.keys(infos).map((id) => ({ id })),
    }),
  });
}

test('LiteLLM prices use reported per-token rates and preserve unknown versus explicit free', async () => {
  const [provider] = await resolvePiProviderCatalog(
    { FARMSLOT_PI_OLLAMA: '0', LITELLM_URL: 'http://litellm.test/v1' },
    {
      fetchImpl: modelInfoFetch({
        priced: {
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.000008,
          cache_read_input_token_cost: 0.0000005,
          cache_creation_input_token_cost: 0.0000025,
          cache_creation_input_token_cost_above_1hr: 0.000004,
          input_cost_per_token_above_200k_tokens: 0.000004,
          output_cost_per_token_above_200k_tokens: 0.000012,
        },
        missing: {},
        free: {
          input_cost_per_token: '0',
          output_cost_per_token: '0',
          cache_read_input_token_cost: '',
        },
        captured: {
          input_cost_per_token: 0.000004,
          output_cost_per_token: 0.00002,
          cache_read_input_token_cost: 0.0000004,
          cache_creation_input_token_cost: 0.000005,
          input_cost_per_token_above_272k_tokens: '8e-06',
          output_cost_per_token_above_272k_tokens: '3e-05',
          cache_read_input_token_cost_above_272k_tokens: '8e-07',
          cache_creation_input_token_cost_above_272k_tokens: '1e-05',
        },
      }),
    },
  );
  const [priced, missing, free, captured] = provider.models;
  assert.equal(priced.cost.input, 2);
  assert.equal(priced.cost.output, 8);
  assert.equal(priced.cost.cacheRead, 0.5);
  assert.equal(priced.cost.cacheWrite, 2.5);
  assert.equal(priced.cost.cacheWrite1h, 4);
  assert.deepEqual(priced.cost.tiers, [
    {
      inputTokensAbove: 200000,
      input: 4,
      output: 12,
      cacheRead: 0.5,
      cacheWrite: 2.5,
      cacheWrite1h: 4,
    },
  ]);
  assert.equal(missing.cost, null);
  assert.equal(free.cost.input, 0);
  assert.equal(free.cost.output, 0);
  assert.equal(free.cost.cacheRead, null, 'missing cache prices are not free');
  assert.equal(free.cost.cacheWrite, null);
  assert.deepEqual(captured.cost.tiers, [
    { inputTokensAbove: 272000, input: 8, output: 30, cacheRead: 8e-7 * 1_000_000, cacheWrite: 10 },
  ]);
  assert.deepEqual(piSdkModels([captured])[0].cost.tiers, captured.cost.tiers);
});

test('LiteLLM thinking maps follow declared levels and flags without model-name guesses', async () => {
  const [provider] = await resolvePiProviderCatalog(
    { FARMSLOT_PI_OLLAMA: '0', LITELLM_URL: 'http://litellm.test/v1' },
    {
      fetchImpl: modelInfoFetch({
        listed: { supports_reasoning: true, reasoning_effort_levels: ['low', 'high', 'max'] },
        flagged: {
          supports_reasoning: true,
          supports_max_reasoning_effort: true,
          supports_xhigh_reasoning_effort: true,
          supports_minimal_reasoning_effort: false,
        },
        unknown: { supports_reasoning: true },
      }),
    },
  );
  const [listed, flagged, unknown] = provider.models;
  assert.equal(listed.thinkingLevelMap.max, 'max');
  assert.equal(listed.thinkingLevelMap.medium, null);
  assert.equal(listed.thinkingLevelMap.xhigh, null);
  assert.equal(flagged.thinkingLevelMap.max, 'max');
  assert.equal(flagged.thinkingLevelMap.xhigh, 'xhigh');
  assert.equal(flagged.thinkingLevelMap.minimal, null);
  assert.equal(flagged.thinkingLevelMap.high, undefined, 'leave unreported ordinary levels to Pi');
  assert.equal(unknown.thinkingLevelMap, undefined, 'do not invent extended effort support');
});

test('LiteLLM model info supplies real DeepSeek limits and reasoning', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => ({
      data: String(url).endsWith('/model/info')
        ? [
            {
              model_name: 'deepseek-v4p1-flash',
              model_info: {
                max_input_tokens: 1048576,
                max_output_tokens: 393216,
                supports_reasoning: true,
              },
            },
          ]
        : [{ id: 'deepseek-v4p1-flash' }, { id: 'unrelated' }],
    }),
  });
  const [provider] = await resolvePiProviderCatalog(
    { FARMSLOT_PI_OLLAMA: '0', LITELLM_URL: 'http://litellm.test/v1' },
    { fetchImpl },
  );
  assert.equal(provider.models[0].contextWindow, 1048576);
  assert.equal(provider.models[0].maxTokens, 393216);
  assert.equal(provider.models[0].reasoning, true);
  assert.equal(provider.models[1].contextWindow, 128000);
});

test('model-specific comparison limits cap DeepSeek without changing other LiteLLM models', async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    json: async () => ({
      data: String(url).endsWith('/model/info')
        ? [
            {
              model_name: 'deepseek-v4p1-flash',
              model_info: {
                max_input_tokens: 1048576,
                max_output_tokens: 393216,
                supports_reasoning: true,
              },
            },
          ]
        : [{ id: 'deepseek-v4p1-flash' }, { id: 'unrelated' }],
    }),
  });
  const [provider] = await resolvePiProviderCatalog(
    {
      FARMSLOT_PI_OLLAMA: '0',
      LITELLM_URL: 'http://litellm.test/v1',
      FARMSLOT_PI_LITELLM_MODEL_LIMITS: JSON.stringify({
        'deepseek-v4p1-flash': { contextWindow: 1048576, maxTokens: 32768, reasoning: true },
      }),
    },
    { fetchImpl },
  );
  assert.equal(provider.models[0].contextWindow, 1048576);
  assert.equal(provider.models[0].maxTokens, 32768);
  assert.equal(provider.models[0].reasoning, true);
  assert.equal(provider.models[1].maxTokens, 8192);
  assert.equal(provider.models[1].reasoning, false);
});

test('model-specific fallback survives unavailable LiteLLM info and never inflates reported limits', async () => {
  const env = {
    FARMSLOT_PI_OLLAMA: '0',
    LITELLM_URL: 'http://litellm.test/v1',
    FARMSLOT_PI_LITELLM_MODEL_LIMITS: JSON.stringify({
      'deepseek-v4p1-flash': { contextWindow: 1048576, maxTokens: 32768, reasoning: true },
    }),
  };
  const [provider] = await resolvePiProviderCatalog(env, {
    fetchImpl: async (url) =>
      String(url).endsWith('/model/info')
        ? { ok: false }
        : {
            ok: true,
            json: async () => ({ data: [{ id: 'deepseek-v4p1-flash' }] }),
          },
  });
  assert.equal(provider.models[0].contextWindow, 1048576);
  assert.equal(provider.models[0].maxTokens, 32768);
  assert.equal(provider.models[0].reasoning, true);
  const [smaller] = await resolvePiProviderCatalog(env, {
    fetchImpl: modelsFetch({
      id: 'deepseek-v4p1-flash',
      context_length: 262144,
      max_output_tokens: 16384,
    }),
  });
  assert.equal(smaller.models[0].contextWindow, 262144);
  assert.equal(smaller.models[0].maxTokens, 16384);
});

test('model-specific configuration rejects malformed JSON, unknown fields and invalid values', async () => {
  for (const value of [
    'bad',
    '[]',
    'null',
    '{"model":false}',
    '{"model":{"context_length":1048576}}',
    '{"model":{"maxTokens":0}}',
    '{"model":{"reasoning":"maybe"}}',
  ])
    await assert.rejects(
      resolvePiProviderCatalog(
        { ...routerEnv, FARMSLOT_PI_ROUTER_MODEL_LIMITS: value },
        { fetchImpl: modelsFetch({ id: 'model' }) },
      ),
      PiProviderConfigurationError,
      piSdkModels,
    );
});

test('reasoning-enabled LiteLLM requests have the same wire guard and record as router requests', async () => {
  const [provider] = await resolvePiProviderCatalog(
    { FARMSLOT_PI_OLLAMA: '0', LITELLM_URL: 'http://litellm.test/v1' },
    {
      fetchImpl: modelsFetch({ id: 'model', reasoning: true }),
    },
  );
  let sent = 0;
  const records = [];
  const fetch = providerReasoningFetch(
    async () => {
      sent++;
      return new Response('OK');
    },
    [provider],
    (record) => records.push(record),
  );
  await assert.rejects(
    fetch('http://litellm.test/v1/chat/completions', {
      body: JSON.stringify({ model: 'model', reasoning_effort: 'none' }),
    }),
    /refusing a non-reasoning request/,
  );
  await fetch('http://litellm.test/v1/chat/completions', {
    body: JSON.stringify({
      model: 'model',
      reasoning_effort: 'medium',
      max_completion_tokens: 32768,
    }),
  });
  assert.equal(sent, 1);
  assert.equal(records[0].provider, 'litellm');
  assert.equal(records[0].effort, 'medium');
  assert.equal(records[0].reasoning, true);
  assert.equal(records[0].requestedMaxTokens, 32768);
});

async function checkExtension(extensionUrl, scenario, obsDir) {
  const assert = (await import('node:assert/strict')).default;
  const { default: install } = await import(extensionUrl);
  const originalEnv = process.env;
  const originalFetch = globalThis.fetch;
  process.env = {
    PI_CODING_AGENT_DIR: `${obsDir}/synthetic-agent`,
    FARMSLOT_PI_OLLAMA: '0',
    FARMSLOT_OBS_DIR: obsDir,
    FARMSLOT_PI_REQUEST_TIMEOUT_MS: '300000',
    ...(!scenario.startsWith('no-thinking')
      ? { FARMSLOT_THINKING: scenario.startsWith('off') ? 'off' : 'medium' }
      : {}),
  };
  const providerId = scenario === 'reload' ? 'router' : 'litellm';
  const baseUrl = `http://${providerId}.test/v1`;
  process.env[providerId === 'router' ? 'FARMSLOT_PI_ROUTER_URL' : 'LITELLM_URL'] = baseUrl;
  if (scenario === 'reload') console.error = () => {};
  let sent = 0;
  const baseFetch = async (input) => {
    if (String(input).endsWith('/model/info'))
      return Response.json({
        data:
          scenario === 'unsupported-level'
            ? [{ model_name: 'model', model_info: { reasoning_effort_levels: ['low'] } }]
            : [],
      });
    if (scenario === 'catalog-failed' && String(input).endsWith('/models'))
      throw new Error('fixture discovery unavailable');
    if (String(input).endsWith('/models'))
      return Response.json({
        data: [
          {
            id: 'model',
            context_length: 1048576,
            max_output_tokens: 32768,
            ...(providerId === 'litellm'
              ? {
                  reasoning: [
                    'reasoning',
                    'unsupported-level',
                    'wire-mismatch',
                    'off-reasoning',
                    'no-thinking-reasoning',
                  ].includes(scenario),
                }
              : {}),
          },
        ],
      });
    console.error('fixture inference attempted');
    sent++;
    return new Response('OK');
  };
  globalThis.fetch = baseFetch;
  const load = async () => {
    const events = new Map();
    const records = [];
    const providers = new Map();
    const runtime = { active: true };
    await install({
      on: (event, handler) => events.set(event, handler),
      registerProvider: (id, provider) => providers.set(id, provider),
      appendEntry: (_type, record) => {
        if (!runtime.active) throw new Error('Extension runtime was invalidated by reload');
        records.push(record);
      },
    });
    return { events, records, runtime, providers };
  };
  const request = () =>
    globalThis.fetch(`${baseUrl}/chat/completions`, {
      body: JSON.stringify({
        model: 'model',
        ...([
          'no-thinking',
          'no-thinking-reasoning',
          'off',
          'off-reasoning',
          'wire-mismatch',
        ].includes(scenario)
          ? {}
          : { reasoning_effort: 'medium' }),
        max_completion_tokens: 32768,
      }),
    });
  try {
    if (scenario.startsWith('catalog-')) process.argv.push('--list-models');
    const before = await load();
    if (scenario.startsWith('catalog-')) {
      await before.events.get('session_shutdown')?.({ reason: 'exit' });
      return;
    }
    let shutdownRequested = false;
    let aborted = false;
    const model = { ...before.providers.get(providerId).models[0], provider: providerId };
    const ctx = {
      model,
      hasUI: false,
      abort: () => {
        aborted = true;
      },
      shutdown: () => {
        shutdownRequested = true;
        setImmediate(async () => {
          assert.equal(aborted, true);
          const { readFileSync } = await import('node:fs');
          const hooks = readFileSync(`${obsDir}/hooks.jsonl`, 'utf8')
            .trim()
            .split('\n')
            .map(JSON.parse);
          assert.equal(hooks.at(-1).event, 'StopFailure');
          assert.match(hooks.at(-1).failure, /PI_REASONING_EFFORT_MISMATCH/);
          await before.events.get('session_shutdown')?.({ reason: 'exit' });
          console.error('fixture orderly shutdown complete');
          process.exit(0);
        });
      },
    };
    if (scenario === 'wire-mismatch') {
      await before.events.get('session_start')?.({}, ctx);
      const { default: OpenAI } = await import('openai');
      const sdk = new OpenAI({
        apiKey: 'fixture-key',
        baseURL: baseUrl,
        fetch: globalThis.fetch,
        maxRetries: 0,
      });
      // The fetch guard requests orderly shutdown even when the SDK masks its exception.
      await assert.rejects(
        sdk.chat.completions.create({ model: 'model', messages: [] }),
        /Connection error/,
      );
      assert.equal(shutdownRequested, true);
      await new Promise(() => {});
      return;
    }
    if (scenario !== 'reload') {
      if (scenario === 'model-select') await before.events.get('model_select')?.({ model }, ctx);
      else await before.events.get('session_start')?.({}, ctx);
      if (shutdownRequested) await new Promise(() => {});
      // Refused lifecycle hooks must never continue to task delivery or inference.
      assert.equal(await (await request()).text(), 'OK');
      assert.equal(sent, 1);
      assert.equal(
        before.records[0].effort,
        ['no-thinking', 'no-thinking-reasoning', 'off', 'off-reasoning'].includes(scenario)
          ? undefined
          : 'medium',
      );
      await before.events.get('session_shutdown')?.({ reason: 'exit' });
      return;
    }
    assert.equal(await (await request()).text(), 'OK');
    const sdkCost = before.providers.get('router').models[0].cost;
    assert.ok(
      Object.values(sdkCost).every((rate) => typeof rate === 'number'),
      'Pi receives numeric SDK rates',
    );
    assert.equal(
      before.records[0].cost,
      null,
      'SDK placeholders never become quoted request prices',
    );
    const previousFetch = globalThis.fetch;
    await before.events.get('session_shutdown')?.({ reason: 'reload' });
    before.runtime.active = false;
    const after = await load();
    assert.equal(await (await request()).text(), 'OK');
    assert.equal(before.records.length, 1);
    assert.equal(after.records.length, 1, 'only the current extension records the request');
    // SDK clients may retain the previous fetch function across a reload.
    assert.equal(
      await (
        await previousFetch('http://router.test/v1/chat/completions', {
          body: JSON.stringify({ model: 'model', reasoning_effort: 'medium' }),
        })
      ).text(),
      'OK',
    );
    assert.equal(before.records.length, 1);
    assert.equal(after.records.length, 1);
    assert.equal(sent, 3);
    await after.events.get('session_shutdown')?.({ reason: 'exit' });
    assert.equal(globalThis.fetch, baseFetch);
  } finally {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  }
}

function runExtensionCheck(scenario) {
  // The supported Node floor needs explicit type stripping; a fresh process also
  // isolates the extension's fetch and environment ownership from other tests.
  const extensionUrl = new URL('./pi-farmslot-observability.ts', import.meta.url).href;
  const obsDir = mkdtempSync(join(tmpdir(), 'pi-extension-'));
  try {
    return spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `await (${checkExtension.toString()})(${JSON.stringify(extensionUrl)}, ${JSON.stringify(scenario)}, ${JSON.stringify(obsDir)});`,
      ],
      { encoding: 'utf8', timeout: 4000 },
    );
  } finally {
    rmSync(obsDir, { recursive: true, force: true });
  }
}

test('extension reload retires the old fetch recorder before its runtime is invalidated', () => {
  const result = runExtensionCheck('reload');
  assert.equal(result.status, 0, result.stderr);
});

for (const scenario of ['session-start', 'model-select', 'unsupported-level', 'wire-mismatch'])
  test(`extension stops on ${scenario} effort mismatch before inference or retries`, () => {
    const result = runExtensionCheck(scenario);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /PI_REASONING_EFFORT_MISMATCH: Model litellm\/model requested medium/,
    );
    assert.match(result.stderr, /FARMSLOT_PI_LITELLM_MODEL_LIMITS/);
    assert.match(result.stderr, /fixture orderly shutdown complete/);
    assert.match(result.stderr, /reasoning.*model.*thinking/i);
    assert.equal(result.stderr.match(/PI_REASONING_EFFORT_MISMATCH/g)?.length, 1);
    assert.doesNotMatch(
      result.stderr,
      /fixture inference attempted|fixture SDK caught|Connection error/,
    );
  });

for (const scenario of [
  'reasoning',
  'no-thinking',
  'off',
  'no-thinking-reasoning',
  'off-reasoning',
])
  test(`extension allows ${scenario} model requests`, () => {
    const result = runExtensionCheck(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /PI_REASONING_EFFORT_MISMATCH/);
  });

for (const [failure, routerId] of ['http', 'timeout', 'json', 'empty'].flatMap((failure) =>
  ['router', 'localsparks'].map((id) => [failure, id]),
)) {
  test(`configured ${routerId} discovery reports ${failure} separately from optional discovery`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const reports = [];
    const catalog = resolvePiProviderCatalog(
      { FARMSLOT_PI_ROUTER_URL: 'http://router.test/v1', FARMSLOT_PI_ROUTER_ID: routerId },
      {
        onDiscovery: (report) => reports.push(report),
        fetchImpl: async (url, { signal }) => {
          if (!String(url).includes('router.test')) throw new Error('optional offline');
          if (failure === 'http') return { ok: false };
          if (failure === 'json')
            return {
              ok: true,
              json: async () => {
                throw new SyntaxError('private error');
              },
            };
          if (failure === 'timeout')
            return new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            );
          return Response.json({ data: [] });
        },
      },
    );
    await Promise.resolve();
    t.mock.timers.tick(400);
    assert.deepEqual(await catalog, []);
    assert.deepEqual(
      reports.find((report) => report.provider === routerId),
      {
        provider: routerId,
        configured: true,
        status: failure === 'empty' ? 'ready' : 'failed',
        modelCount: 0,
      },
    );
    assert.deepEqual(
      reports.find((report) => report.provider === 'ollama'),
      {
        provider: 'ollama',
        configured: false,
        status: 'failed',
        modelCount: 0,
      },
    );
    assert.doesNotMatch(JSON.stringify(reports), /router.test|private error/);
  });
}

for (const [setting, configured] of [
  ['OLLAMA_HOST', false],
  ['OLLAMA_BASE_URL', false],
  ['FARMSLOT_PI_OLLAMA', true],
  ['FARMSLOT_PI_OLLAMA_URL', true],
]) {
  test(`unreachable Ollama with ${setting} is ${configured ? 'required' : 'optional'} for catalog listing`, async (t) => {
    const { listPiModelCatalog } = await import('./pi-farmslot-providers.mjs');
    const server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    const endpoint = `http://127.0.0.1:${address.port}`;
    const env = {
      OLLAMA_HOST: endpoint,
      [setting]: setting === 'FARMSLOT_PI_OLLAMA' ? '1' : endpoint,
    };
    const reports = [];
    assert.deepEqual(
      await resolvePiProviderCatalog(env, { onDiscovery: (report) => reports.push(report) }),
      [],
    );
    const dir = mkdtempSync(join(tmpdir(), 'pi-ollama-catalog-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const binary = join(dir, 'pi-fixture');
    writeFileSync(
      binary,
      `#!${process.execPath}
if (process.argv.includes('-e')) {
  const { resolvePiProviderCatalog } = await import(${JSON.stringify(new URL('./pi-farmslot-providers.mjs', import.meta.url).href)});
  const sources = [];
  await resolvePiProviderCatalog(process.env, { onDiscovery: source => sources.push(source) });
  console.log(JSON.stringify({ type: 'farmslot.pi-provider-discovery', sources }));
}
console.log('provider model\\nxai native-model');
`,
      { mode: 0o755 },
    );
    const listing = listPiModelCatalog(binary, env, { args: ['-e', 'fixture'] });
    if (configured)
      await assert.rejects(listing, /Pi configured provider ollama discovery is incomplete/);
    else
      assert.deepEqual(await listing, {
        ids: ['xai/native-model'],
        nativeIds: ['xai/native-model'],
        aliases: {},
        configuredProviders: [],
      });
    assert.deepEqual(reports, [
      { provider: 'ollama', configured, status: 'failed', modelCount: 0 },
    ]);
  });
}

for (const scenario of ['catalog-ready', 'catalog-failed']) {
  test(`extension emits a structured discovery report during ${scenario} listing`, () => {
    const result = runExtensionCheck(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      type: 'farmslot.pi-provider-discovery',
      sources: [
        {
          provider: 'litellm',
          configured: true,
          status: scenario === 'catalog-ready' ? 'ready' : 'failed',
          modelCount: scenario === 'catalog-ready' ? 1 : 0,
        },
      ],
    });
  });
}
test('node Pi catalogs discover router models with canonical ids and only real aliases', async (t) => {
  const { listPiModelCatalog } = await import('./pi-farmslot-providers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pi-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, 'pi-fixture');
  writeFileSync(
    binary,
    '#!/bin/sh\nprintf "provider model\\nlocalsparks native-only\\nrouter retired\\nlitellm native-b\\nxai grok-4.7\\n"\n',
    { mode: 0o755 },
  );
  for (const id of ['localsparks', 'local-sparks']) {
    const requests = [];
    const result = await listPiModelCatalog(
      binary,
      {
        FARMSLOT_PI_OLLAMA: '0',
        FARMSLOT_PI_ROUTER_URL: 'http://router.test',
        FARMSLOT_PI_ROUTER_ID: id,
        LITELLM_URL: 'https://litellm.invalid/v1',
      },
      {
        fetchImpl: async (url) => {
          requests.push(String(url));
          return Response.json({ data: [{ id: 'GLM-5.3-Flash-s12' }] });
        },
      },
    );
    assert.deepEqual(requests, ['http://router.test/v1/models']);
    assert.deepEqual(result.nativeIds, [
      'localsparks/native-only',
      'router/retired',
      'litellm/native-b',
      'xai/grok-4.7',
    ]);
    assert.ok(result.ids.includes(`${id}/GLM-5.3-Flash-s12`));
    assert.equal(result.ids.includes('router/GLM-5.3-Flash-s12'), false);
    assert.deepEqual(result.aliases, { 'router/GLM-5.3-Flash-s12': `${id}/GLM-5.3-Flash-s12` });
    assert.equal(Object.hasOwn(result.aliases, 'router/native-only'), false);
    assert.equal(result.ids.includes('router/retired'), false);
    if (id === 'localsparks') assert.equal(result.ids.includes('localsparks/native-only'), false);
    assert.equal(result.ids.includes('xai/grok-4.7'), true);
    assert.equal(result.ids.includes('litellm/native-b'), true);
  }
  assert.deepEqual(
    (
      await listPiModelCatalog(binary, {
        FARMSLOT_PI_OLLAMA: '0',
        FARMSLOT_PI_ROUTER_ID: 'localsparks',
      })
    ).aliases,
    {},
  );
});

test('default node catalog preserves main membership and order without provider discovery', async (t) => {
  const { listPiModelCatalog } = await import('./pi-farmslot-providers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pi-default-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, 'pi-fixture');
  writeFileSync(
    binary,
    '#!/bin/sh\nprintf "provider model\\nlitellm native-b\\nrouter saved\\nlitellm native-a\\nxai grok-4.7\\nlitellm native-b\\n"\n',
    { mode: 0o755 },
  );
  // Frozen output of main's decodePiModelList for the same native table.
  const expected = ['litellm/native-b', 'router/saved', 'litellm/native-a', 'xai/grok-4.7'];
  for (const id of [undefined, 'router']) {
    let requests = 0;
    const result = await listPiModelCatalog(
      binary,
      {
        FARMSLOT_PI_ROUTER_ID: id,
        FARMSLOT_PI_ROUTER_URL: 'https://router.invalid/v1',
        LITELLM_URL: 'https://litellm.invalid/v1',
      },
      {
        fetchImpl: async () => {
          requests++;
          return Response.json({ data: [{ id: 'discovered-only' }] });
        },
      },
    );
    assert.equal(requests, 0, 'default catalogs must not discover providers');
    assert.deepEqual(result.ids, expected);
    assert.deepEqual(result.aliases, {});
  }
});

test('worker catalogs accept only confirmed empty native listings', async (t) => {
  const { listPiModelCatalog, PiModelListFormatError } =
    await import('./pi-farmslot-providers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pi-empty-native-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, 'pi-fixture');
  writeFileSync(
    binary,
    `#!/bin/sh
if [ "$#" -gt 1 ]; then
  printf 'provider model\\nlocalsparks discovered-only\\n'
else
  printf '%s' "$NATIVE_OUTPUT"
  printf '%s' "$NATIVE_STDERR" >&2
  exit "$NATIVE_STATUS"
fi
`,
    { mode: 0o755 },
  );
  const list = (output, status = '0', stderr = '') =>
    listPiModelCatalog(
      binary,
      { NATIVE_OUTPUT: output, NATIVE_STATUS: status, NATIVE_STDERR: stderr },
      { args: ['-e', 'fixture'] },
    );
  const guidance =
    'No models available. Use /login to log into a provider via OAuth or API key. See:\n' +
    '  /synthetic/pi/docs/providers.md\n  /synthetic/pi/docs/models.md\n';
  for (const output of ['No models available\n', guidance]) {
    const listing = await list(output);
    assert.deepEqual(listing.ids, ['localsparks/discovered-only']);
    assert.deepEqual(listing.nativeIds, []);
  }
  for (const output of [
    '',
    'warning only\n',
    'provider model\n',
    'No models available!\n',
    'warning\nNo models available\n',
    'No models available\nwarning\n',
    `warning\n${guidance}`,
    `${guidance}warning\n`,
    guidance.replace('/docs/models.md', '/other/models.md'),
  ])
    await assert.rejects(list(output), PiModelListFormatError);
  await assert.rejects(list('No models available\n', '1'), /native model listing failed/);
  await assert.rejects(list(guidance, '1'), /native model listing failed/);
  await assert.rejects(list(guidance, '0', 'warning\n'), PiModelListFormatError);
});

test('shared Pi table decoder rejects missing headers and empty tables before discovery', async (t) => {
  const { decodePiModelList, PiModelListFormatError, listPiModelCatalog } =
    await import('./pi-farmslot-providers.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pi-invalid-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, 'pi-fixture');
  writeFileSync(binary, '#!/bin/sh\nprintf "warning only\\n"\n', { mode: 0o755 });
  let requests = 0;
  await assert.rejects(
    listPiModelCatalog(
      binary,
      {
        FARMSLOT_PI_OLLAMA: '0',
        FARMSLOT_PI_ROUTER_ID: 'localsparks',
        FARMSLOT_PI_ROUTER_URL: 'https://router.invalid/v1',
      },
      {
        fetchImpl: async () => {
          requests++;
          return Response.json({ data: [{ id: 'discovered-only' }] });
        },
      },
    ),
    /header/,
  );
  assert.equal(requests, 0);
  assert.throws(() => decodePiModelList('warning only'), PiModelListFormatError);
  assert.throws(() => decodePiModelList('provider model context\n'), /no models/);
  assert.deepEqual(
    decodePiModelList(
      '\x1b[1mprovider model context\x1b[0m\nxai grok-4.7\nxai grok-4.7\n!invalid ignored\n',
    ),
    ['xai/grok-4.7'],
  );
});

test('dispatch and accounting share normalization, including invalid rates and sparse tiers', async () => {
  const { parseLiteLlmPrices } = await import('../../packages/slot-config/src/session-usage.ts');
  const info = {
    input_cost_per_token: -1,
    output_cost_per_token: '0.00001',
    cache_read_input_token_cost: 'Infinity',
    cache_creation_input_token_cost_above_1hr: '0.000004',
    output_cost_per_reasoning_token: '0.00002',
    input_cost_per_token_above_200k_tokens: '0.000004',
    cache_read_input_token_cost_above_272k_tokens: '0.000001',
  };
  const [provider] = await resolvePiProviderCatalog(
    { FARMSLOT_PI_OLLAMA: '0', LITELLM_URL: 'http://litellm.test/v1' },
    { fetchImpl: modelInfoFetch({ fixture: { ...info, supports_reasoning: true } }) },
  );
  const cost = parseLiteLlmPrices({ data: [{ model_name: 'fixture', model_info: info }] }).get(
    'fixture',
  );
  assert.equal(provider.models[0].cost.input, null);
  assert.deepEqual(provider.models[0].cost, cost);
  assert.equal(cost.tiers[1].input, null, 'sparse tiers inherit base rates');
});
