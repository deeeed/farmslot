import assert from 'node:assert/strict';
import test from 'node:test';

import { configureCursorModel } from './cursor-model.js';

for (const [alias, model, parameter, value] of [
  ['cursor-grok-4.6-xhigh', 'grok-4.6', 'effort', 'xhigh'],
  ['composer-2.5-fast', 'composer-2.5', 'fast', 'true'],
  ['claude-opus-5-thinking-high', 'claude-opus-5', 'thinking', 'true'],
  ['claude-4.6-opus-high-thinking', 'claude-opus-4-6', 'effort', 'high'],
  ['gpt-5.6-sol[reasoning=high]', 'gpt-5.6-sol', 'reasoning', 'high'],
  ['auto', 'auto-smart', 'model', 'auto-smart'],
])
  test(`Cursor confirms the native selection for ${alias}`, async () => {
    const option = (id: string, values: string[], category = '') => ({
      id,
      category,
      currentValue: values[0],
      options: values.map((value) => ({ value })),
    });
    const choices = [
      option('model', [model]),
      option('thinking', ['false', 'true'], 'thought_level'),
      option('effort', ['medium', 'high', 'xhigh'], 'thought_level'),
      option('reasoning', ['medium', 'high'], 'thought_level'),
      option('fast', ['false', 'true']),
    ];
    await configureCursorModel(
      'session',
      { configOptions: choices },
      alias,
      async (method, params) => {
        assert.equal(method, 'session/set_config_option');
        assert.equal(params.sessionId, 'session');
        const selected = choices.find((choice) => choice.id === params.configId)!;
        assert(selected.options.some((option) => option.value === params.value));
        selected.currentValue = String(params.value);
        return { configOptions: structuredClone(choices) };
      },
    );
    assert.equal(choices.find((choice) => choice.id === 'model')!.currentValue, model);
    assert.equal(choices.find((choice) => choice.id === parameter)!.currentValue, value);
  });

test('Cursor refuses a model switch that the native API did not confirm', async () => {
  await assert.rejects(
    configureCursorModel(
      'session',
      { configOptions: [{ id: 'model', options: [{ value: 'requested' }] }] },
      'requested',
      async () => ({ configOptions: [{ id: 'model', currentValue: 'other' }] }),
    ),
    /did not select/,
  );
});
