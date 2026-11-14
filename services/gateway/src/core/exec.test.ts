import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { COMMAND_WATCHDOG, execFileArgv, execLocal } from './exec.js';

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

test('the command watchdog kills only still-registered groups when its pipe closes, in sh and dash', async (t) => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  for (const shell of ['/bin/sh', '/bin/dash'].filter((file) => existsSync(file))) {
    const groups = [0, 1, 2].map(() => spawn('sleep', ['30'], { detached: true, stdio: 'ignore' }));
    t.after(() => {
      for (const group of groups)
        if (group.pid && alive(group.pid)) process.kill(-group.pid, 'SIGKILL');
    });
    const [kept, exited, other] = groups.map((group) => group.pid!);
    const watchdog = spawn(shell, ['-c', COMMAND_WATCHDOG], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    watchdog.stderr.on('data', (chunk) => (stderr += chunk));
    watchdog.stdin.end(`+${kept}\n+${exited}\n+${other}\n-${exited}\n`);
    const code = await new Promise((resolve) => watchdog.once('exit', resolve));
    assert.equal(code, 0, `${shell}: ${stderr}`);
    // The kill is synchronous in the shell; the exit events follow.
    await Promise.all(
      [groups[0], groups[2]].map(
        (group) =>
          new Promise((resolve) =>
            group.exitCode !== null || group.signalCode !== null
              ? resolve(null)
              : group.once('exit', resolve),
          ),
      ),
    );
    assert.equal(groups[0].signalCode, 'SIGKILL', `${shell} kills a registered group`);
    assert.equal(groups[2].signalCode, 'SIGKILL', `${shell} kills every registered group`);
    assert.equal(alive(exited), true, `${shell} leaves an unregistered group alone`);
  }
});
