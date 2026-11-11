import assert from 'node:assert/strict';
import test from 'node:test';

import { storeWorkerFailure } from '../src/worker-protocol.js';

test('SQLite primary and extended I/O failures preserve their codes and retire the VFS', () => {
  for (const resultCode of [10, 266, 11, 26]) {
    const error = Object.assign(new Error('SQLite failure'), { resultCode });
    assert.deepEqual(storeWorkerFailure(7, error), {
      id: 7,
      ok: false,
      message: 'SQLite failure',
      resultCode,
      fatal: true,
    });
  }
  assert.deepEqual(storeWorkerFailure(8, new Error('invalid request')), {
    id: 8,
    ok: false,
    message: 'invalid request',
    fatal: false,
  });
  assert.deepEqual(storeWorkerFailure(9, new Error('VFS could not pause'), true), {
    id: 9,
    ok: false,
    message: 'VFS could not pause',
    fatal: true,
  });
});
