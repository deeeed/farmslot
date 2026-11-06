import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { NativeSessionClient } from './client.js';

test('opening native inventory never starts a missing host or runs a provider command', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-passive-'));
  const start = t.mock.method(childProcess, 'spawn', () => {
    throw new Error('An observation tried to start a host');
  });
  syncBuiltinESMExports();
  try {
    const client = new NativeSessionClient(root);
    assert.deepEqual(await client.list('owner'), []);
    assert.equal(start.mock.callCount(), 0);
    assert.equal(existsSync(join(root, 'host.json')), false);
    await assert.rejects(client.inspect('owner', 'missing'), { code: 'NATIVE_SOURCE_UNAVAILABLE' });
    assert.equal(start.mock.callCount(), 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});
