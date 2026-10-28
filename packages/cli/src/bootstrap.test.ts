import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

async function startBootstrap(t: TestContext, args: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), 'farmslot-bootstrap-'));
  await mkdir(path.join(root, 'bin'));
  await mkdir(path.join(root, 'src'));
  await copyFile(path.join(packageDir, 'bin/farmslot.mjs'), path.join(root, 'bin/farmslot.mjs'));
  await symlink(path.resolve(packageDir, '../../node_modules'), path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { paths: { '@probe': ['./src/probe.ts'] } } }),
  );
  await writeFile(path.join(root, 'src/probe.ts'), 'export const value: number = 42;');
  const entry = (name: string) => `
    import { value } from '@probe';
    const timer = setInterval(() => {}, 50);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
      console.log(JSON.stringify({ signal, cleanup: true }));
      clearInterval(timer);
      process.exitCode = 23;
    });
    console.log(JSON.stringify({ pid: process.pid, entry: '${name}', args: process.argv.slice(2), value }));
  `;
  await writeFile(path.join(root, 'src/entry.ts'), entry('normal'));
  await writeFile(path.join(root, 'src/scripted-runner-entry.ts'), entry('scripted'));
  const cacheGuard = path.join(root, 'cache-guard.mjs');
  await writeFile(
    cacheGuard,
    `
    import fs from 'node:fs';
    import { basename } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const readDirectory = fs.readdirSync;
    fs.readdirSync = (directory, ...options) => {
      if (basename(String(directory)).startsWith('tsx-')) {
        throw new Error('CLI startup scanned the shared TSX disk cache');
      }
      return readDirectory(directory, ...options);
    };
    syncBuiltinESMExports();
  `,
  );
  const child = spawn(
    process.execPath,
    ['--import', cacheGuard, path.join(root, 'bin/farmslot.mjs'), ...args],
    {
      cwd: tmpdir(),
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: 'missing-parent/tsconfig.json',
        TSX_DISABLE_CACHE: '',
      },
      stdio: 'pipe',
      detached: true,
    },
  );
  let output = '';
  let stderr = '';
  let runtimePid: number | undefined;
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    for (const pid of new Set([child.pid, runtimePid])) {
      if (!pid) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await closed;
    await rm(root, { recursive: true, force: true });
  });
  const ready = await new Promise<{ pid: number; entry: string; args: string[]; value: number }>(
    (resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`bootstrap not ready: ${stderr}`)), 3000);
      child.once('error', reject);
      child.once('close', () => {
        clearTimeout(deadline);
        if (!runtimePid) reject(new Error(`bootstrap exited before readiness: ${stderr}`));
      });
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (runtimePid || !output.includes('\n')) return;
        const row = JSON.parse(output.split('\n')[0]!);
        runtimePid = row.pid;
        clearTimeout(deadline);
        resolve(row);
      });
    },
  );
  return { child, ready, closed, output: () => output, stderr: () => stderr };
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  test(
    `bootstrap delivers PID-only ${signal} and preserves application cleanup exit`,
    { timeout: 4900 },
    async (t) => {
      const fixture = await startBootstrap(t, ['recipe', 'run', 'a path with spaces']);
      assert.deepEqual(fixture.ready.args, ['recipe', 'run', 'a path with spaces']);
      assert.equal(fixture.ready.entry, 'normal');
      assert.equal(fixture.ready.value, 42);
      fixture.child.kill(signal);
      let timeout: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          fixture.closed,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`signal did not close bootstrap: ${fixture.stderr()}`)),
              1000,
            );
          }),
        ]);
        assert.deepEqual(result, { code: 23, signal: null });
        assert.deepEqual(JSON.parse(fixture.output().trim().split('\n').at(-1)!), {
          signal,
          cleanup: true,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
  );
}

test(
  'bootstrap selects the scripted entry and preserves its arguments',
  { timeout: 4900 },
  async (t) => {
    const fixture = await startBootstrap(t, ['scripted-runner', '--task-dir', 'task path']);
    assert.equal(fixture.ready.entry, 'scripted');
    assert.deepEqual(fixture.ready.args, ['scripted-runner', '--task-dir', 'task path']);
    fixture.child.kill('SIGTERM');
    assert.deepEqual(await fixture.closed, { code: 23, signal: null });
  },
);
