import assert from 'node:assert/strict';
import { test } from 'node:test';

import { setQaInputField } from './qa-input-fields.js';

test('nested profile edits preserve scope defaults and never mutate the profile', () => {
  const inputs = { scope: { kind: 'window', ref: 'main', hours: 24 }, team: 'payments' };
  const changed = setQaInputField(inputs, 'scope.hours', 48);
  assert.deepEqual(changed, {
    scope: { kind: 'window', ref: 'main', hours: 48 },
    team: 'payments',
  });
  assert.equal(inputs.scope.hours, 24);
  assert.deepEqual(setQaInputField(changed, 'scope.hours', undefined), {
    scope: { kind: 'window', ref: 'main' },
    team: 'payments',
  });
  assert.throws(() => setQaInputField(inputs, '__proto__.value', 'bad'), /Invalid QA input path/);
});
