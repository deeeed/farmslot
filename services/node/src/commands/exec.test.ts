import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { exec, resolveExecPoolDir, resolveLoginEnvironment, resolveLoginPath } from './exec.js';
import { ExecRequests } from './exec-requests.js';

test('node command exec preserves a cached non-PATH login export', async () => {
  const key = 'FARMSLOT_TEST_LOGIN_EXPORT';
  const previous = process.env[key];
  process.env[key] = 'captured-once';
  try {
    const expectedEnvironment = await resolveLoginEnvironment();
    delete process.env[key];
    const result = await exec({ cmd: `printf %s "$${key}"` });

    assert.equal(expectedEnvironment[key], 'captured-once');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'captured-once');
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

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

test('node command exec reuses the cached login PATH without a login shell', async () => {
  const expectedEnvironment = await resolveLoginEnvironment();
  const expectedPath = expectedEnvironment.PATH;
  const pathResult = await exec({ cmd: 'printf %s "$PATH"' });
  const loginResult = await exec({
    cmd: 'if [ -n "$ZSH_VERSION" ]; then [[ -o login ]] && printf login || printf nonlogin; else shopt -q login_shell && printf login || printf nonlogin; fi',
  });

  assert.equal(pathResult.exitCode, 0);
  assert.equal(pathResult.stdout, expectedPath);
  assert.equal(loginResult.exitCode, 0);
  assert.equal(loginResult.stdout, 'nonlogin');
});

test('node exec captures stdout larger than one pipe chunk', async () => {
  const result = await exec({
    cmd: "python3 - <<'PY'\nprint('x' * 50000, end='')\nPY",
    maxBuffer: 100000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 50000);
});

const closingProcess = `
  process.on('SIGTERM', () => { process.stdout.write('closed'); process.exit(0); });
  process.stdout.write(JSON.stringify({ pid: process.pid }) + String.fromCharCode(10));
  setInterval(() => {}, 50);
`;

for (const scenario of [
  {
    name: 'cancellation waits for the signal handler',
    source: closingProcess,
    disconnect: false,
    forced: false,
  },
  {
    name: 'connection close waits for its owned process',
    source: closingProcess,
    disconnect: true,
    forced: false,
  },
  {
    name: 'cancellation kills a stubborn descendant after its parent exits',
    source: `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write(JSON.stringify({ pid: Number(process.argv[1]) }) + String.fromCharCode(10)); setInterval(() => {}, 50);", String(process.pid)], { stdio: 'inherit' });
      setInterval(() => {}, 50);
    `,
    disconnect: false,
    forced: true,
  },
]) {
  test(`scoped exec ${scenario.name}`, { timeout: 4000 }, async (t) => {
    const owner = new ExecRequests();
    let pid: number | undefined;
    let output = '';
    let connectionClosed: Promise<void> | undefined;
    t.after(async () => {
      owner.cancel('process');
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await owner.close();
    });
    const result = await owner.run('process', (signal) =>
      exec(
        {
          requestScoped: true,
          closeoutTimeoutMs: 60,
          argv: [process.execPath, '-e', scenario.source],
        },
        (stream, data) => {
          if (stream !== 'stdout') return;
          output += data;
          if (!pid && output.includes('\n')) {
            pid = JSON.parse(output.split('\n')[0]!).pid;
            if (scenario.disconnect) connectionClosed = owner.close();
            else owner.cancel('process');
          }
        },
        signal,
      ),
    );
    await connectionClosed;
    assert.equal(result.exitCode, 130);
    if (scenario.forced) assert.match(result.stderr, /forced termination/);
    else assert.equal(result.stdout.split('\n').at(-1), 'closed');
    assert.equal(owner.cancel('process'), false);
  });
}

test(
  'scoped exec refuses an absent owner and does not start after cancellation',
  { timeout: 4000 },
  async () => {
    const params = {
      requestScoped: true,
      argv: [process.execPath, '-e', 'process.stdout.write("started")'],
    };
    await assert.rejects(exec(params), /request owner/);
    const controller = new AbortController();
    controller.abort();
    const result = await exec(params, undefined, controller.signal);
    assert.equal(result.exitCode, 130);
    assert.equal(result.stdout, '');
  },
);

test(
  'scoped exec supplies the daemon pool directory to a command',
  { timeout: 4000 },
  async (t) => {
    const previous = process.env.FARMSLOT_POOL_DIR;
    process.env.FARMSLOT_POOL_DIR = '/pool/request-proof';
    t.after(() => {
      if (previous === undefined) delete process.env.FARMSLOT_POOL_DIR;
      else process.env.FARMSLOT_POOL_DIR = previous;
    });
    const result = await exec(
      {
        requestScoped: true,
        argv: [process.execPath, '-e', 'process.stdout.write(process.env.FARMSLOT_POOL_DIR)'],
      },
      undefined,
      new AbortController().signal,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '/pool/request-proof');
  },
);

test('scoped exec resolves the default pool in checkout and deployed layouts', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'node-exec-pool-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const layout of [
    { name: '@farmslot/node', directory: 'checkout/services/node', pool: 'checkout/pool' },
    { name: '@farmslot/node-standalone', directory: 'node-dev', pool: 'node-dev/pool' },
  ]) {
    const nodeRoot = path.join(root, layout.directory);
    await mkdir(nodeRoot, { recursive: true });
    await writeFile(path.join(nodeRoot, 'package.json'), JSON.stringify({ name: layout.name }));
    const moduleUrl = pathToFileURL(path.join(nodeRoot, 'src/commands/exec.ts')).href;
    assert.equal(resolveExecPoolDir(moduleUrl, ''), path.join(root, layout.pool));
    assert.equal(
      resolveExecPoolDir(moduleUrl, './configured-pool'),
      path.resolve('./configured-pool'),
    );
  }
});
