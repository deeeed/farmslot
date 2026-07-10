import assert from 'node:assert/strict';
import test from 'node:test';

import { workerSessionHistoryEnabled } from './worker-session-history.js';

test('worker session history is enabled by default and can be explicitly disabled', (t) => {
  const previous = process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY;
  t.after(() => {
    if (previous === undefined) delete process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY;
    else process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY = previous;
  });

  delete process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY;
  assert.equal(workerSessionHistoryEnabled(), true);

  process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY = '1';
  assert.equal(workerSessionHistoryEnabled(), true);

  process.env.FARMSLOT_EXPERIMENTAL_WORKER_HISTORY = '0';
  assert.equal(workerSessionHistoryEnabled(), false);
});
