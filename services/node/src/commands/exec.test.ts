import assert from 'node:assert/strict';
import test from 'node:test';

import { exec } from './exec.js';

test('node exec maxBuffer preserves bytes up to the limit and reports overflow', async () => {
  const result = await exec({ cmd: 'printf abcdef; sleep 1', maxBuffer: 4 });

  assert.equal(result.stdout, 'abcd');
  assert.match(result.stderr, /maxBuffer exceeded after 6 bytes/);
  assert.equal(result.exitCode, 1);
});

test('node exec captures stdout larger than one pipe chunk', async () => {
  const result = await exec({
    cmd: "python3 - <<'PY'\nprint('x' * 50000, end='')\nPY",
    maxBuffer: 100000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 50000);
});
