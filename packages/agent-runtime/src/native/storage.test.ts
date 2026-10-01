import assert from 'node:assert/strict';
import test from 'node:test';

import { alive, processGroupAlive } from './storage.js';

test('permission-denied presence probes remain conservative without breaking reads', (t) => {
  t.mock.method(process, 'kill', (_pid, signal) => {
    assert.equal(signal, 0);
    throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
  });
  assert.equal(alive(process.pid), true);
  assert.equal(processGroupAlive(process.pid), true);
});
