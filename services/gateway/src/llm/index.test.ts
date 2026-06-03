import assert from 'node:assert/strict';
import test from 'node:test';

import { getModel } from '@earendil-works/pi-ai';

import { callLLM, fallbackDoneTextDelta, TIER_MAP } from './index.js';

const getModelById = getModel as (provider: string, model: string) => unknown;

test('openai-codex tier defaults resolve to pi-ai registered model ids', () => {
  for (const tier of ['fast', 'standard', 'smart']) {
    const model = TIER_MAP[tier]?.['openai-codex'];
    assert.equal(typeof model, 'string');
    assert.ok(
      getModelById('openai-codex', model),
      `${tier} mapped to unregistered openai-codex model ${model}`,
    );
  }
});

test('streaming fallback emits done text only when deltas were absent', () => {
  assert.equal(fallbackDoneTextDelta('', 'final answer', 'stop'), 'final answer');
  assert.equal(fallbackDoneTextDelta('partial', 'final answer', 'stop'), null);
  assert.equal(fallbackDoneTextDelta('', 'tool preface', 'toolUse'), null);
  assert.equal(fallbackDoneTextDelta('', '', 'stop'), null);
});

test('callLLM can fail closed instead of using CLI fallback without API auth', async () => {
  await assert.rejects(
    callLLM({
      provider: '__no_api_auth_for_unit_test__',
      model: 'fast',
      userPrompt: 'classify',
      allowCliFallback: false,
    }),
    /CLI fallback disabled/,
  );
});
