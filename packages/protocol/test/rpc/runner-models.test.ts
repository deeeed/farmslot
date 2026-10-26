import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runnerModelCatalogObservationParams,
  runnerModelCatalogResourceKey,
  type RunnerModelCatalogResult,
  runnerModelCatalogStoredData,
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
