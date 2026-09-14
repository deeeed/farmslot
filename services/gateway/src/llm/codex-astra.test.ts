import assert from 'node:assert/strict';
import test from 'node:test';

import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

import { CODEX_ASTRA_MODEL, registerCodexAstra, reportedLlmCost } from './codex-astra.js';
import { llmDefaultsForProvider } from './config.js';

test('Astra supplements the same Codex provider and keeps all authentication/stream functions', () => {
  const models = builtinModels();
  const before = models.getProvider('openai-codex')!;
  const existing = before.getModels();
  registerCodexAstra(models);
  const provider = models.getProvider('openai-codex')!;
  assert.equal(provider.auth, before.auth);
  assert.equal(provider.stream, before.stream);
  assert.equal(provider.streamSimple, before.streamSimple);
  assert.equal(provider.baseUrl, before.baseUrl);
  for (const model of existing) assert.equal(models.getModel(provider.id, model.id), model);
  const astra = models.getModel(provider.id, CODEX_ASTRA_MODEL)!;
  assert.equal(astra.api, 'openai-codex-responses');
  assert.equal(astra.contextWindow, 272_000);
  assert.equal(astra.maxTokens, 128_000);
  assert.deepEqual(getSupportedThinkingLevels(astra), ['low', 'medium', 'high', 'xhigh', 'max']);
  registerCodexAstra(models);
  assert.equal(
    models.getModels(provider.id).filter((model) => model.id === CODEX_ASTRA_MODEL).length,
    1,
  );
});

test('an upstream Astra descriptor stays authoritative and missing providers are not created', () => {
  const models = builtinModels();
  registerCodexAstra(models);
  const provider = models.getProvider('openai-codex')!;
  const astra = models.getModel(provider.id, CODEX_ASTRA_MODEL)!;
  registerCodexAstra(models);
  assert.equal(models.getProvider(provider.id), provider);
  assert.equal(models.getModel(provider.id, CODEX_ASTRA_MODEL), astra);
  const empty = createModels();
  registerCodexAstra(empty);
  assert.equal(empty.getProviders().length, 0);
});

test('Astra defaults apply only to the existing Codex provider; subscription cost remains unknown', () => {
  assert.equal(llmDefaultsForProvider('openai-codex').intelligenceModel, CODEX_ASTRA_MODEL);
  assert.equal(llmDefaultsForProvider('openai-codex').copilotModel, CODEX_ASTRA_MODEL);
  assert.equal(llmDefaultsForProvider('openai-codex').intelligenceEffort, 'low');
  assert.equal(llmDefaultsForProvider('anthropic').intelligenceModel, 'fast');
  assert.equal(llmDefaultsForProvider('anthropic').copilotModel, 'standard');
  assert.equal(reportedLlmCost('openai-codex', 0.53), undefined);
  assert.equal(reportedLlmCost('openai', 0.53), 0.53);
});
