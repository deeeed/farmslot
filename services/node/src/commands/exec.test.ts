import assert from 'node:assert/strict';
import test from 'node:test';

import { exec, resolveLoginPath } from './exec.js';

test('node exec maxBuffer preserves bytes up to the limit and reports overflow', async () => {
  const result = await exec({ cmd: 'printf abcdef; sleep 1', maxBuffer: 4 });

  assert.equal(result.stdout, 'abcd');
  assert.match(result.stderr, /maxBuffer exceeded after 6 bytes/);
  assert.equal(result.exitCode, 1);
});

test('node argv exec preserves shell metacharacters as one literal argument', async () => {
  const payload = 'foo;touch /tmp/pwned`id`$(id)';
  const result = await exec({
    argv: [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      payload,
    ],
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), [payload]);
});

test('node argv exec uses the login-shell PATH with the system fallback', async () => {
  const resolved = await resolveLoginPath();
  assert.match(resolved, /\/usr\/bin/);
  const inheritedEntry = (process.env.PATH ?? '').split(':').find(Boolean);
  assert.ok(inheritedEntry);
  assert.ok(resolved.split(':').includes(inheritedEntry));
});

test('node exec captures stdout larger than one pipe chunk', async () => {
  const result = await exec({
    cmd: "python3 - <<'PY'\nprint('x' * 50000, end='')\nPY",
    maxBuffer: 100000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 50000);
});
