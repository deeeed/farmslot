import assert from 'node:assert/strict';
import test from 'node:test';

import { exec, resolveLoginPath } from './exec.js';

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

test('node argv exec passes shell metacharacters as one literal argument', async () => {
  const hostile = 'foo;touch /tmp/pwned`id`$(id)';
  const result = await exec({
    argv: [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv[1]))',
      hostile,
    ],
  });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout), hostile);
});

test('node argv exec uses the login-shell PATH plus system fallback', async () => {
  const loginPath = await resolveLoginPath();
  const result = await exec({
    argv: [process.execPath, '-e', 'process.stdout.write(process.env.PATH ?? "")'],
  });

  assert.equal(result.exitCode, 0);
  assert.ok(result.stdout.startsWith(loginPath));
  assert.match(result.stdout, /\/usr\/sbin:\/usr\/bin:\/sbin:\/bin$/);
});
