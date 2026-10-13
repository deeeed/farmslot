import assert from 'node:assert/strict';
import test from 'node:test';

import { sourceScopeFromOptions } from './sources.js';

test('source mutations require one explicit scope while status defaults to the farm', () => {
  assert.equal(sourceScopeFromOptions({}), undefined);
  assert.throws(() => sourceScopeFromOptions({}, true), /exactly one/);
  assert.throws(() => sourceScopeFromOptions({ farm: true, node: 'node-1' }, true), /exactly one/);
  assert.throws(() => sourceScopeFromOptions({ run: 'run-1', node: 'node-1' }), /exactly one/);
  assert.deepEqual(sourceScopeFromOptions({ node: 'node-1' }, true), {
    scope: 'node',
    targetId: 'node-1',
  });
  assert.deepEqual(sourceScopeFromOptions({ run: 'run-1' }, true), {
    scope: 'run',
    targetId: 'run-1',
  });
  assert.deepEqual(sourceScopeFromOptions({ farm: true }, true), {
    scope: 'farm',
    targetId: 'farm',
  });
});
