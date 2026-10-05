import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveRecipeValue } from '../src/core/parameters.js';
import { RecipeResolutionError } from '../src/core/resolution-error.js';

const params = { count: 3, nested: { value: true } };

test('strict resolution interpolates references and refuses a missing parameter', () => {
  assert.deepEqual(resolveRecipeValue({ a: '{{params.count}}', c: 'x {{params.count}}' }, params), {
    a: 3,
    c: 'x 3',
  });
  assert.throws(
    () => resolveRecipeValue('{{params.missing}}', params),
    (error) => error instanceof RecipeResolutionError && error.code === 'RECIPE_PARAMS_INVALID',
  );
});

test('lenient resolution replaces only exact references to parameters that exist', () => {
  assert.deepEqual(
    resolveRecipeValue(
      {
        a: '{{params.count}}',
        b: ['{{params.nested.value}}', '{{params.missing}}', '{{params.count.deeper}}'],
        c: 'x {{params.count}}',
        d: '{{outputs.node.value}}',
      },
      params,
      new Map([['node', { value: 1 }]]),
      { lenient: true },
    ),
    {
      a: 3,
      b: [true, '{{params.missing}}', '{{params.count.deeper}}'],
      c: 'x {{params.count}}',
      d: '{{outputs.node.value}}',
    },
  );
});
