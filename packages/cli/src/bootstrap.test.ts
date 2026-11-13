import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));

interface BootstrapOptions {
  managedRuntime?: boolean;
  pinLayout?: 'legacy' | 2;
  symlinkPinStore?: boolean;
  farmHome?: string;
}

async function startBootstrap(t: TestContext, args: string[], options: BootstrapOptions = {}) {
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'farmslot-bootstrap-')));
  const home = path.join(scratch, 'custom farm');
  if (options.symlinkPinStore) {
    const store = path.join(home, ...(options.pinLayout === 2 ? ['state'] : []), 'task-pins');
    const target = path.join(scratch, 'external', 'task-pins');
    await mkdir(path.dirname(store), { recursive: true });
    await mkdir(target, { recursive: true });
    await symlink(target, store);
  }
  const root = options.pinLayout
    ? path.join(
        home,
        ...(options.pinLayout === 2 ? ['state'] : []),
        'task-pins',
        'fixture',
        'cli',
        'packages',
        'cli',
      )
    : scratch;
  const managedRuntime = options.managedRuntime;
  if (options.pinLayout === 2) {
    await mkdir(path.join(home, 'config'), { recursive: true });
    await writeFile(path.join(home, 'config/instance.json'), '{"layout":2}');
  }
  await mkdir(root, { recursive: true });
  await mkdir(path.join(root, 'bin'));
  await mkdir(path.join(root, 'src'));
  const managedDir = path.join(root, 'managed runtime');
  if (managedRuntime) {
    await mkdir(managedDir);
    await copyFile(
      process.execPath,
      path.join(managedDir, path.basename(process.execPath)),
      constants.COPYFILE_FICLONE,
    );
  }
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
    console.log(JSON.stringify({ pid: process.pid, execPath: process.execPath, entry: '${name}', args: process.argv.slice(2), value, farmHome: process.env.FARMSLOT_HOME }));
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
        FARMSLOT_NODE22_BIN: managedRuntime ? managedDir : '',
        FARMSLOT_HOME: options.farmHome,
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
  let didClose = false;
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('close', (code, signal) => {
      didClose = true;
      resolve({ code, signal });
    });
  });
  t.after(async () => {
    // After close the process group can disappear or be reused. Kill only a live fixture.
    for (const pid of didClose ? [] : new Set([child.pid, runtimePid])) {
      if (!pid) continue;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    await closed;
    await rm(scratch, { recursive: true, force: true });
  });
  const ready = await new Promise<{
    pid: number;
    execPath: string;
    entry: string;
    args: string[];
    value: number;
    farmHome?: string;
  }>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`bootstrap not ready: ${stderr}`)), 4500);
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
  });
  return {
    child,
    home: await realpath(scratch).then((directory) => path.join(directory, 'custom farm')),
    ready,
    closed,
    managedNode: path.join(managedDir, path.basename(process.execPath)),
    output: () => output,
    stderr: () => stderr,
  };
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

test(
  'bootstrap uses the configured machine Node even when invoked by another interpreter',
  { timeout: 4900 },
  async (t) => {
    const fixture = await startBootstrap(
      t,
      ['rpc', 'runtime.capability.list', '{"slotId":"fixture"}'],
      { managedRuntime: true },
    );
    assert.equal(fixture.ready.execPath, await realpath(fixture.managedNode));
    assert.equal(
      fixture.ready.pid,
      fixture.child.pid,
      'runtime handoff preserves the signal-owning PID',
    );
    assert.deepEqual(fixture.ready.args, [
      'rpc',
      'runtime.capability.list',
      '{"slotId":"fixture"}',
    ]);
    fixture.child.kill('SIGTERM');
    assert.deepEqual(await fixture.closed, { code: 23, signal: null });
  },
);

for (const pinLayout of ['legacy', 2] as const) {
  test(`a pinned CLI recovers its farm home in layout ${pinLayout}`, async (t) => {
    const fixture = await startBootstrap(t, ['task', 'verify', 'synthetic-task'], { pinLayout });
    assert.equal(fixture.ready.farmHome, fixture.home);
    fixture.child.kill('SIGTERM');
    assert.deepEqual(await fixture.closed, { code: 23, signal: null });
  });
  test(`a pinned CLI preserves its logical home through a symlinked layout ${pinLayout} store`, async (t) => {
    const fixture = await startBootstrap(t, ['task', 'verify', 'synthetic-task'], {
      pinLayout,
      symlinkPinStore: true,
    });
    assert.equal(fixture.ready.farmHome, fixture.home);
    fixture.child.kill('SIGTERM');
    assert.deepEqual(await fixture.closed, { code: 23, signal: null });
  });
}

test('a pinned CLI preserves an explicit farm home', async (t) => {
  const fixture = await startBootstrap(t, ['task', 'verify', 'synthetic-task'], {
    pinLayout: 'legacy',
    farmHome: '/explicit/farm',
  });
  assert.equal(fixture.ready.farmHome, '/explicit/farm');
  fixture.child.kill('SIGTERM');
  assert.deepEqual(await fixture.closed, { code: 23, signal: null });
});
