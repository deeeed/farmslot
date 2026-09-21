import assert from 'node:assert/strict';
import { test } from 'node:test';

import { redactRecipeParams } from '../src/core/invocation.js';

test('only preserves explicitly typed safe key-slot indices', () => {
  const schema = { type: 'object', properties: { api_key_index: { type: 'integer' } } };
  assert.deepEqual(redactRecipeParams({ api_key_index: 8 }, schema), {
    params: { api_key_index: 8 },
    redactedPaths: [],
  });
  for (const [params, definition] of [
    [{ api_key_index: 'secret' }, schema],
    [{ api_key_index: 8 }, {}],
    [{ api_key_index: -1 }, schema],
    [{ api_key_index: 1.5 }, schema],
    [{ api_key: 8 }, { properties: { api_key: { type: 'integer' } } }],
  ]) {
    assert.equal(redactRecipeParams(params, definition).redactedPaths.length, 1);
  }
});

test('redacts nested credentials, assignments and authenticated URLs', () => {
  const result = redactRecipeParams(
    {
      items: [{ token: 'secret-value' }],
      url: 'https://user:secret@example.invalid',
      options: 'api_key=secret-value',
      hash: 'a'.repeat(64),
    },
    {},
  );
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
  assert.equal(JSON.stringify(result).includes('user:secret'), false);
  assert.equal(result.params.hash, 'a'.repeat(64));
  assert.deepEqual(result.redactedPaths, ['/items/0/token', '/url', '/options']);
});
