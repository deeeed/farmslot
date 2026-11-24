import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { editsTypedSince, tierModelOverride, tierModelsToSave } from './llm-tier-models.js';

const builtIn = {
  fast: { anthropic: 'haiku', 'codex-lb': 'gpt-6.2-astra' },
  standard: { anthropic: 'sonnet', 'codex-lb': 'gpt-6.2-astra' },
  smart: { anthropic: 'opus', 'codex-lb': 'gpt-6.2-astra' },
};

test('the Settings tier cells save every typed override and keep the saved ones', () => {
  const saved = { 'codex-lb': { smart: 'gpt-6-luna' } };
  assert.equal(tierModelOverride(saved, 'codex-lb', 'smart'), 'gpt-6-luna');
  assert.equal(tierModelOverride(saved, 'codex-lb', 'fast'), '', 'unset shows the placeholder');
  assert.equal(tierModelOverride(saved, 'codex-lb', 'turbo'), '');
  assert.deepEqual(
    tierModelsToSave(
      saved,
      { 'codex-lb': { fast: ' gpt-5.6-terra ', standard: 'gpt-6-luna' } },
      builtIn,
    ),
    { 'codex-lb': { fast: 'gpt-5.6-terra', standard: 'gpt-6-luna', smart: 'gpt-6-luna' } },
  );
});

test('an emptied cell or one set to the built-in id saves no override', () => {
  const saved = { 'codex-lb': { fast: 'gpt-5.6-terra' }, anthropic: { fast: 'sonnet' } };
  assert.deepEqual(
    tierModelsToSave(saved, { 'codex-lb': { fast: '' }, anthropic: { fast: 'haiku' } }, builtIn),
    {},
  );
});

test('a cell typed while a save was in flight keeps its text after the save', () => {
  const sent = { 'codex-lb': { fast: 'gpt-5.6-terra', standard: 'gpt-6-luna' } };
  assert.deepEqual(
    editsTypedSince(sent, { 'codex-lb': { fast: 'gpt-5.6-terra', standard: 'gpt-6-lu' } }),
    { 'codex-lb': { standard: 'gpt-6-lu' } },
  );
  assert.deepEqual(editsTypedSince(sent, sent), {});
});
