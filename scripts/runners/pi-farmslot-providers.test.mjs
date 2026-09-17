import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchOpenAiModelIds,
  listPiProviderSources,
  openaiBaseUrl,
  resolvePiProviderCatalog,
} from './pi-farmslot-providers.mjs';

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
