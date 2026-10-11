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

test('execFileArgv preserves shell metacharacters as one literal argument', async () => {
  const payload = 'foo;touch /tmp/pwned`id`$(id)';
  const result = await execFileArgv([
    process.execPath,
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    payload,
  ]);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), [payload]);
});

test(
  'local cancellation waits for owned cleanup and refuses an already aborted request',
  { timeout: 4000 },
  async (t) => {
    const controller = new AbortController();
    let pid: number | undefined;
    let output = '';
    t.after(() => {
      controller.abort();
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    });
    const argv = [
      process.execPath,
      '-e',
      `
    process.on('SIGTERM', () => { process.stdout.write('closed'); process.exit(0); });
    process.stdout.write(process.pid + String.fromCharCode(10));
    setInterval(() => {}, 50);
  `,
    ];
    const result = await execFileArgv(argv, {
      signal: controller.signal,
      closeoutTimeoutMs: 100,
      onOutput(stream, data) {
        if (stream !== 'stdout') return;
        output += data;
        if (!pid && output.includes('\n')) {
          pid = Number(output.split('\n')[0]);
          controller.abort();
        }
      },
    });
    assert.equal(result.exitCode, 130);
    assert.match(result.stdout, /closed$/);
    const skipped = await execFileArgv(argv, { signal: controller.signal });
    assert.equal(skipped.stdout, '');
    assert.equal(skipped.exitCode, 130);
  },
);
