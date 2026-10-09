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

test('lenient resolution keeps falsy parameter values', () => {
  assert.deepEqual(
    resolveRecipeValue(
      {
        zero: '{{params.zero}}',
        off: '{{params.off}}',
        empty: '{{params.empty}}',
        nil: '{{params.nil}}',
      },
      { zero: 0, off: false, empty: '', nil: null },
      undefined,
      { lenient: true },
    ),
    { zero: 0, off: false, empty: '', nil: null },
  );
});

// The close-all cleanup node and its `baseline` output, from a retained 0.86.0 trace that compared
// "0.00297" against the unresolved template text.
const closeAllOutputs = new Map<string, unknown>([
  [
    'baseline',
    {
      action: 'metamask.perps.read_positions',
      count: 1,
      matchingCount: 1,
      positions: [{ coin: 'BTC', size: '0.00297', side: null, entryPrice: '84326.0' }],
    },
  ],
]);

test('output references index arrays with [n] or a numeric segment', () => {
  const assertSize = {
    action: 'assert_output',
    source: 'final-positions',
    assert: {
      path: '$.positions[0].size',
      operator: 'eq',
      value: '{{outputs.baseline.positions[0].size}}',
    },
    intent: 'The owned preview leaves the pre-existing BTC position size unchanged',
    next: 'final-orders',
  };
  assert.deepEqual(resolveRecipeValue(assertSize, {}, closeAllOutputs), {
    ...assertSize,
    assert: { ...assertSize.assert, value: '0.00297' },
  });
  assert.equal(
    resolveRecipeValue('{{outputs.baseline.positions.0.size}}', {}, closeAllOutputs),
    '0.00297',
  );
  assert.equal(
    resolveRecipeValue('{{outputs.baseline.positions[0].side}}', {}, closeAllOutputs),
    null,
  );
  assert.equal(
    resolveRecipeValue('size {{outputs.baseline.positions[0].size}}', {}, closeAllOutputs),
    'size 0.00297',
  );
  assert.deepEqual(resolveRecipeValue('{{params.items[1]}}', { items: ['a', { b: 2 }] }), { b: 2 });
});

test('a missing array entry names the producing node', () => {
  for (const missing of [
    '{{outputs.baseline.positions[1].size}}',
    '{{outputs.baseline.positions.length}}',
    '{{outputs.baseline.count[0]}}',
  ]) {
    assert.throws(
      () => resolveRecipeValue(missing, {}, closeAllOutputs),
      (error) =>
        error instanceof RecipeResolutionError &&
        error.code === 'RECIPE_PARAMS_INVALID' &&
        error.message.includes('baseline.'),
      missing,
    );
  }
});

test('strict resolution refuses a template it cannot parse instead of keeping its text', () => {
  for (const unsupported of [
    '{{outputs.baseline.positions[first].size}}',
    '{{outputs.baseline.positions[-1].size}}',
    'size {{outputs.baseline.positions[0]size}}',
    '{{ params.count }}',
    '{{params.count',
  ]) {
    assert.throws(
      () => resolveRecipeValue(unsupported, params, closeAllOutputs),
      (error) =>
        error instanceof RecipeResolutionError &&
        error.code === 'RECIPE_PARAMS_INVALID' &&
        error.message.includes('not a supported template'),
      unsupported,
    );
    assert.equal(
      resolveRecipeValue(unsupported, params, closeAllOutputs, { lenient: true }),
      unsupported,
    );
  }
  // Before outputs exist (composition, trust planning) an unparsable output reference fails too.
  assert.throws(
    () => resolveRecipeValue('{{outputs.baseline.positions[x]}}', params),
    (error) => error instanceof RecipeResolutionError && error.code === 'RECIPE_PARAMS_INVALID',
  );
  assert.equal(
    resolveRecipeValue('{{outputs.baseline.positions[0].size}}', params),
    '{{outputs.baseline.positions[0].size}}',
  );
});

test('a resolution error quotes the authored template and the node', () => {
  const rejects = (template: string, expected: RegExp, values = {}, nodeId?: string) =>
    assert.throws(
      () => resolveRecipeValue(template, values, closeAllOutputs, { nodeId }),
      (error) =>
        error instanceof RecipeResolutionError &&
        error.code === 'RECIPE_PARAMS_INVALID' &&
        expected.test(error.message),
      template,
    );
  rejects(
    '{{params.arr[1][0]}}',
    /^Recipe parameter \{\{params\.arr\[1\]\[0\]\}\}: index 1 is out of range for an array of 1\.$/u,
    { arr: [[0]] },
  );
  rejects(
    'size {{outputs.baseline.positions[1].size}}',
    /^Recipe output \{\{outputs\.baseline\.positions\[1\]\.size\}\} in node assert-size: index 1 is out of range for an array of 1\.$/u,
    {},
    'assert-size',
  );
  rejects(
    '{{outputs.baseline.missing}}',
    /^Recipe output \{\{outputs\.baseline\.missing\}\} is not defined\.$/u,
  );
  rejects(
    '{{outputs.baseline.positions[x]}}',
    /^Recipe value \{\{outputs\.baseline\.positions\[x\]\}\} in node cleanup\/assert-size is not a supported template\.$/u,
    {},
    'cleanup/assert-size',
  );
});

test('an index on an object reads that key', () => {
  assert.equal(resolveRecipeValue('{{params.byId[7]}}', { byId: { 7: 'seven' } }), 'seven');
  assert.equal(resolveRecipeValue('{{params.byId.7}}', { byId: { 7: 'seven' } }), 'seven');
});
