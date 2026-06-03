import assert from 'node:assert/strict';
import test from 'node:test';

import { recoveryHealthIsReady } from './recovery.js';

test('recoveryHealthIsReady requires configured ready indicator to match', () => {
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: 'OK\n' }, 'OK'), true);
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: 'MANIFEST_ONLY\n' }, 'OK'), false);
  assert.equal(recoveryHealthIsReady({ exitCode: 0, stdout: '' }, 'OK'), false);
  assert.equal(recoveryHealthIsReady({ exitCode: 1, stdout: 'OK\n' }, 'OK'), false);
});
