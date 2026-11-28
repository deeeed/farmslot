import assert from 'node:assert/strict';
import test from 'node:test';

import { catalogForNativeRunners, DEFAULT_REVIEW_DISPATCH_CATALOG } from '../src/catalog.js';
import { ReviewDispatchViewModel } from '../src/view-model.js';

test('antigravity native catalog preserves display names and hides unsupported effort controls', () => {
  assert.ok(DEFAULT_REVIEW_DISPATCH_CATALOG.runners.some((r) => r.id === 'antigravity'));
  const catalog = catalogForNativeRunners(
    [
      {
        runner: 'antigravity',
        nativeOnly: true,
        defaultModel: '',
        models: [],
        nodeModels: {
          local: ['gemini-4-neon-high', 'gemini-3.8-flash-low'],
        },
        modelLabels: {
          'gemini-4-neon-high': 'Gemini 4 Neon (High)',
          'gemini-3.8-flash-low': 'Gemini 3.8 Flash (Low)',
        },
        modes: ['default', 'plan'],
        supportsWorkers: true,
      },
    ],
    DEFAULT_REVIEW_DISPATCH_CATALOG,
    'local',
  );
  const antigravity = catalog.runners.find((r) => r.id === 'antigravity');
  assert.ok(antigravity);
  assert.deepEqual(antigravity.efforts, []);
  assert.deepEqual(antigravity.models, [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  ]);

  const vm = new ReviewDispatchViewModel({
    context: { allowedActions: ['chat'] },
    catalog,
    sequence: [
      { runner: 'antigravity', model: 'gemini-3.8-flash-low', effort: null, mode: 'cold' },
    ],
  });
  assert.deepEqual(vm.effortChoices(vm.rows[0].id), [{ value: null, label: 'Supported default' }]);
  assert.equal(vm.selection?.model, 'gemini-3.8-flash-low');
});
