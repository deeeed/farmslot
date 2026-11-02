import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPickerCatalogModel,
  runnerModelCatalogObservationParams,
  runnerModelCatalogResourceKey,
  type RunnerModelCatalogResult,
  runnerModelCatalogStoredData,
  runnerModelProviderLabel,
  type RunnerVisibleModelsGetResult,
  runnerVisibleModelsObservationParams,
  runnerVisibleModelsStoredData,
} from '../../src/rpc/runner-models.js';

test('catalog observation params share the canonical runner query and refuse imperative fields', () => {
  assert.deepEqual(runnerModelCatalogObservationParams({ runner: ' Claude-Code ' }), {
    runner: 'claude',
  });
  assert.deepEqual(
    runnerModelCatalogResourceKey({ runner: 'claude-code' }),
    runnerModelCatalogResourceKey({ runner: 'claude' }),
  );
  assert.deepEqual(runnerModelCatalogResourceKey({ runner: 'cursor' }), {
    family: 'upstream',
    integration: 'providers',
    queryId: 'runner.modelCatalog:{"runner":"cursor"}',
  });
  for (const params of [
    undefined,
    {},
    { runner: '' },
    { runner: null },
    { runner: 4 },
    { runner: 'cursor', refresh: true },
    { runner: 'cursor', command: '/tmp/cursor-agent' },
    [],
  ])
    assert.throws(() => runnerModelCatalogObservationParams(params));
});

test('visible model observation params keep optional fields and slash model IDs', () => {
  assert.deepEqual(runnerVisibleModelsObservationParams(undefined), {});
  assert.deepEqual(runnerVisibleModelsObservationParams({ selectedModel: 'ignored' }), {});
  assert.deepEqual(runnerVisibleModelsObservationParams({ runner: 'claude-code' }), {
    runner: 'claude',
  });
  assert.deepEqual(
    runnerVisibleModelsObservationParams({
      runner: 'pi',
      selectedModel: ' anthropic/claude-opus-5 ',
    }),
    { runner: 'pi', selectedModel: 'anthropic/claude-opus-5' },
  );
  assert.deepEqual(runnerVisibleModelsObservationParams({ runner: 'pi', selectedModel: null }), {
    runner: 'pi',
  });
  assert.deepEqual(runnerVisibleModelsObservationParams({ runner: 'pi', selectedModel: ' ' }), {
    runner: 'pi',
  });
  for (const params of [
    { runner: '' },
    { runner: null },
    { selectedModel: 4 },
    { runner: 'pi', selectedModel: '--unsafe' },
    { runner: 'pi', models: ['x'] },
    { runner: 'pi', defaultModel: null },
  ])
    assert.throws(() => runnerVisibleModelsObservationParams(params));
});

test('durable projections keep IDs, labels, reasoning, visibility, defaults and observations only', () => {
  const catalog = {
    runner: 'cursor',
    status: 'unavailable',
    source: 'catalog-command',
    detail: 'Runner catalog command failed (code: 1, signal: none, killed: false).',
    models: [
      {
        id: 'anthropic/claude-opus-5',
        label: 'Opus',
        reasoningModes: ['high'],
        listed: false,
        stdout: 'raw',
      },
    ],
    observation: {
      status: 'stale',
      observedAt: 1000,
      error: { code: 'RUNNER_MODEL_CATALOG_UNAVAILABLE', message: 'failed', stack: 'x' },
    },
    command: '/Users/private/cursor-agent',
  } as unknown as RunnerModelCatalogResult;
  assert.deepEqual(runnerModelCatalogStoredData(catalog), {
    runner: 'cursor',
    status: 'unavailable',
    source: 'catalog-command',
    detail: catalog.detail,
    models: [
      { id: 'anthropic/claude-opus-5', label: 'Opus', reasoningModes: ['high'], listed: false },
    ],
    observation: {
      status: 'stale',
      observedAt: 1000,
      error: { code: 'RUNNER_MODEL_CATALOG_UNAVAILABLE', message: 'failed' },
    },
  });
  const unsupported: RunnerModelCatalogResult = {
    runner: 'claude',
    status: 'unsupported',
    source: 'unsupported',
    models: [],
  };
  assert.deepEqual(runnerModelCatalogStoredData(unsupported), unsupported);

  const visible = {
    runners: [
      {
        runner: 'pi',
        defaultModel: 'anthropic/claude-opus-5',
        defaultConfigured: true,
        configured: true,
        models: ['anthropic/claude-opus-5'],
        pickerModels: ['anthropic/claude-opus-5', 'anthropic/claude-haiku-4-5'],
        retainedModel: 'anthropic/claude-haiku-4-5',
        path: '/Users/private/.farmslot/runner-visible-models.json',
      },
    ],
    ownerId: 'private',
  } as unknown as RunnerVisibleModelsGetResult;
  const stored = runnerVisibleModelsStoredData(visible);
  assert.deepEqual(stored, {
    runners: [
      {
        runner: 'pi',
        defaultModel: 'anthropic/claude-opus-5',
        defaultConfigured: true,
        configured: true,
        models: ['anthropic/claude-opus-5'],
        pickerModels: ['anthropic/claude-opus-5', 'anthropic/claude-haiku-4-5'],
        retainedModel: 'anthropic/claude-haiku-4-5',
      },
    ],
  });
  assert.doesNotMatch(JSON.stringify(stored), /private/);
});

test('node catalog picker shows labelled providers and current generations only', () => {
  const kept = [
    'litellm/glm-5p3',
    'litellm/DeepSeek-V4-Flash',
    'litellm/kimi-k3',
    'litellm/qwen3p8-max',
    'litellm/gpt-6.1-sol',
    'litellm/gpt-5.2-codex',
    'litellm/gemini-4-argon',
    'litellm/minimax-m3',
    'litellm/claude-fable-5.1',
    'litellm/claude-opus-5-5',
    'anthropic/claude-haiku-5-5',
    'anthropic/claude-opus-5-5',
    'anthropic/claude-sonnet-5-5',
    'anthropic/claude-fable-5-1',
    'xai/grok-4.7',
    'omlx/qwen3.6-35b-a3b',
    'lmstudio/openai/gpt-oss-20b',
  ];
  const dropped = [
    'anthropic/claude-haiku-4-5',
    'anthropic/claude-haiku-4-5-20251001',
    'anthropic/claude-opus-4-8',
    'anthropic/claude-sonnet-4-6',
    'anthropic/claude-3-5-sonnet',
    'xai/grok-4.6',
    'xai/grok-4.3',
    'litellm/grok-4.6',
    'amazon-bedrock/anthropic.claude-opus-5-5',
    'azure/gpt-6',
    'azure-openai-responses/gpt-6',
    'openai/gpt-6',
    'opencode/big-pickle',
    'typesafe/model',
    'glm-5p3',
  ];
  assert.deepEqual(kept.filter(isPickerCatalogModel), kept);
  assert.deepEqual(dropped.filter(isPickerCatalogModel), []);
  assert.equal(runnerModelProviderLabel('litellm/glm-5p3'), 'Consensys LiteLLM');
  assert.equal(runnerModelProviderLabel('xai/grok-4.7'), 'xAI');
  assert.equal(runnerModelProviderLabel('anthropic/claude-opus-5-5'), 'Anthropic');
  assert.equal(runnerModelProviderLabel('omlx/qwen3.8-27b'), 'Local');
  assert.equal(runnerModelProviderLabel('lmstudio/qwen3.8-27b'), 'Local');
  assert.equal(runnerModelProviderLabel('xaix'), undefined);
  assert.equal(runnerModelProviderLabel('gpt-6-astra'), undefined);
  // The offline cache keeps each model's node list.
  assert.deepEqual(
    runnerModelCatalogStoredData({
      runner: 'pi',
      status: 'ready',
      source: 'catalog-command',
      models: [{ id: 'litellm/glm-5p3', reasoningModes: [], listed: true, nodes: ['macpro'] }],
    }).models,
    [{ id: 'litellm/glm-5p3', reasoningModes: [], listed: true, nodes: ['macpro'] }],
  );
});
