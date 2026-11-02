import assert from 'node:assert/strict';
import test from 'node:test';

import { sharedLifetime } from './shared-lifetime';

function counted() {
  const calls = { starts: 0, stops: 0 };
  const acquire = sharedLifetime(() => {
    calls.starts += 1;
    return () => {
      calls.stops += 1;
    };
  });
  return { calls, acquire };
}

test('overlapping holders start the service once and stop it after the last release', () => {
  const { calls, acquire } = counted();
  const first = acquire();
  const second = acquire();
  first();
  assert.deepEqual(calls, { starts: 1, stops: 0 });
  second();
  assert.deepEqual(calls, { starts: 1, stops: 1 });
});

test('a holder released before the next one acquires stops and restarts the service', () => {
  const { calls, acquire } = counted();
  acquire()();
  assert.deepEqual(calls, { starts: 1, stops: 1 });
  const next = acquire();
  assert.deepEqual(calls, { starts: 2, stops: 1 });
  next();
  assert.deepEqual(calls, { starts: 2, stops: 2 });
});

test('a stale release from an earlier lifetime cannot stop the current one', () => {
  const { calls, acquire } = counted();
  const old = acquire();
  old();
  const current = acquire();
  old();
  assert.deepEqual(calls, { starts: 2, stops: 1 }, 'the second release of `old` is ignored');
  current();
  assert.deepEqual(calls, { starts: 2, stops: 2 });
});

test('a start that throws holds nothing, so the next holder starts again', () => {
  let fail = true;
  let starts = 0;
  const acquire = sharedLifetime(() => {
    starts += 1;
    if (fail) throw new Error('start failed');
    return () => {};
  });
  assert.throws(() => acquire(), /start failed/);
  fail = false;
  const release = acquire();
  assert.equal(starts, 2);
  release();
});
