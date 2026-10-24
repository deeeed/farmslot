import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveRecipeUiObservation } from './recipe-ui-observation';

test('a partial local observer preserves the installed host observer', async () => {
  const calls: string[] = [];
  const result = await resolveRecipeUiObservation(
    ['host.ref'],
    () => {
      calls.push('local');
      return undefined;
    },
    (refs) => {
      calls.push('host');
      return { observations: { [refs[0]]: 'host value' } };
    },
    () => assert.fail('Host observations must not fall through to defaults'),
  );
  assert.deepEqual(result, { observations: { 'host.ref': 'host value' } });
  assert.deepEqual(calls, ['local', 'host']);
});

test('handled local observations take priority; unhandled refs retain defaults', async () => {
  const result = await resolveRecipeUiObservation(
    ['local.ref'],
    () => ({ observations: { 'local.ref': 'local value' } }),
    () => assert.fail('A handled local ref must not call the host'),
    () => assert.fail('A handled local ref must not call defaults'),
  );
  assert.deepEqual(result, { observations: { 'local.ref': 'local value' } });
  const fallback = { observations: { 'ui.visible': 'HUD' } };
  assert.equal(
    await resolveRecipeUiObservation(
      ['ui.visible'],
      () => undefined,
      () => undefined,
      () => fallback,
    ),
    fallback,
  );
});
