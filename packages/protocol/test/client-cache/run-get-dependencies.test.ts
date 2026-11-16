import assert from 'node:assert/strict';
import test from 'node:test';

import { resourceQuery } from '../../src/client-cache/index.js';

test('run detail rereads on its own run key, not on every farm-wide run change', () => {
  const query = resourceQuery('run.get', { runId: 'run-1' });
  // The gateway advances this key when a run whose facts run.get serves changes.
  assert.deepEqual(query.dependencies, [{ family: 'run', runId: 'run-1' }]);
});
