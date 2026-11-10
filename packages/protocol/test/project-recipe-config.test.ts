import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateProjectRecipeConfig } from '../src/contracts/config.js';

test('declared checks accept normalized library refs and JSON parameters', () => {
  validateProjectRecipeConfig({
    provider: { module: './provider.mjs' },
    checks: [
      { recipe: ' smoke ', params: { enabled: true, amount: 2, nested: [null, { tag: 'proof' }] } },
      { recipe: 'library/check' },
    ],
  });
});

for (const checks of [
  [],
  null,
  {},
  [null],
  [{}],
  [{ recipe: '' }],
  [{ recipe: '../smoke' }],
  [{ recipe: './smoke' }],
  [{ recipe: '/smoke' }],
  [{ recipe: 'C:\\smoke' }],
  [{ recipe: 'smoke.recipe.json' }],
  [{ recipe: 'smoke', typo: true }],
  [{ recipe: 'smoke', params: [] }],
  [{ recipe: 'smoke', params: { amount: Infinity } }],
  [{ recipe: 'smoke' }, { recipe: ' smoke ' }],
]) {
  test(`invalid default checks refuse: ${JSON.stringify(checks)}`, () => {
    assert.throws(
      () => validateProjectRecipeConfig({ provider: { module: './provider.mjs' }, checks }),
      /recipe.checks/,
    );
  });
}

test('recording capability is an explicit runtime capability identifier', () => {
  const provider = { module: './provider.mjs' };
  validateProjectRecipeConfig({ provider, recordingCapability: 'shared-testnet' });
  for (const recordingCapability of ['', ' gate ', '../gate', 2, null])
    assert.throws(
      () => validateProjectRecipeConfig({ provider, recordingCapability }),
      /recordingCapability/,
    );
});

test('the run evidence viewer config accepts its link switch and a template module', () => {
  const provider = { module: './provider.mjs' };
  validateProjectRecipeConfig({ provider, viewer: { link: false, template: './viewer.mjs' } });
  validateProjectRecipeConfig({ provider, viewer: {} });
  for (const [viewer, field] of [
    [null, 'recipe.viewer'],
    [{ link: 'no' }, 'recipe.viewer.link'],
    [{ template: '' }, 'recipe.viewer.template'],
    [{ open: true }, 'recipe.viewer'],
  ] as const)
    assert.throws(() => validateProjectRecipeConfig({ provider, viewer }), new RegExp(field));
});
