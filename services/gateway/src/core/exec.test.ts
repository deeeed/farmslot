import assert from 'node:assert/strict';
import test from 'node:test';

import { execFileArgv, execLocal } from './exec.js';

test('execLocal maxBuffer preserves bytes up to the limit and reports overflow', async () => {
  const result = await execLocal('printf abcdef; sleep 1', { maxBuffer: 4 });

  assert.equal(result.stdout, 'abcd');
  assert.match(result.stderr, /maxBuffer exceeded after 6 bytes/);
  assert.equal(result.exitCode, 1);
});

test('execLocal captures stdout larger than one pipe chunk', async () => {
  const result = await execLocal("python3 - <<'PY'\nprint('x' * 50000, end='')\nPY", {
    maxBuffer: 100000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 50000);
});

test('execFileArgv passes shell metacharacters as one literal argument', async () => {
  const hostile = 'foo;touch /tmp/pwned`id`$(id)';
  const result = await execFileArgv([
    process.execPath,
    '-e',
    'process.stdout.write(JSON.stringify(process.argv[1]))',
    hostile,
  ]);

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout), hostile);
});
