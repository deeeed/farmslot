import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harness = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/harness/index.ts'),
).href;

// The driver wraps child_process.spawn so a SIGHUP reaches it right after the
// leaf starts and before spawnScriptStreaming returns: the window in which a
// parent signal used to end the harness and leave the detached leaf running.
const DRIVER = `
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const realSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = realSpawn(...args);
  fs.writeFileSync(process.env.LEAF_PID, String(child.pid));
  process.kill(process.pid, 'SIGHUP');
  return child;
};
syncBuiltinESMExports();
const { acquireCheckoutLock, spawnScriptStreaming } = await import(process.env.HARNESS);
const lock = acquireCheckoutLock(process.env.TARGET, 'signal test');
if ('message' in lock) throw new Error(lock.message);
try {
  await spawnScriptStreaming('/bin/sleep', ['600'], process.env.TARGET, { forward: 'none' });
} finally {
  lock.release();
}
`;

// A leaf that ignores SIGTERM, so a timeout escalates to SIGKILL. Its group also
// holds Z, a zombie whose parent M moved to its own group and does not reap it.
// Once the leaf is SIGKILLed and reaped, Z is the group's only member: macOS
// then answers kill(-group) with EPERM, not ESRCH, until Z is reaped. M closes
// the leaf's output pipes so the driver can exit before M does.
const ZOMBIE_LEAF = `
$SIG{TERM} = 'IGNORE';
if (fork() == 0) {
  exit 0 if fork() == 0;
  setpgrp(0, 0);
  close STDOUT; close STDERR;
  open(my $f, '>', $ENV{M_PID}); print $f $$; close $f;
  sleep 10;
  exit 0;
}
sleep 600;
`;

// Runs the zombie leaf to its timeout, then waits until the leaf is reaped: the
// exit handler signals the group again at that point. A throw there ends the driver.
const TIMEOUT_DRIVER = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let leaf = 0;
const realSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = realSpawn(...args);
  leaf = child.pid;
  return child;
};
syncBuiltinESMExports();
const { acquireCheckoutLock, spawnScriptStreaming } = await import(process.env.HARNESS);
const lock = acquireCheckoutLock(process.env.TARGET, 'signal test');
if ('message' in lock) throw new Error(lock.message);
try {
  const result = await spawnScriptStreaming('/usr/bin/perl', ['-e', process.env.LEAF], process.env.TARGET, {
    forward: 'none',
    timeoutMs: 200,
    env: { M_PID: process.env.M_PID },
  });
  const reaped = () => {
    try {
      process.kill(leaf, 0);
      return false;
    } catch (error) {
      return error.code === 'ESRCH';
    }
  };
  for (let i = 0; i < 100 && !reaped(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setImmediate(resolve));
  process.stdout.write(JSON.stringify({ timedOut: result.timedOut === true, reaped: reaped() }));
} finally {
  lock.release();
}
`;

const parentSignals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

describe('spawnScriptStreaming parent signals', () => {
  test(
    'a hangup that arrives while the leaf starts still reaches the leaf',
    { skip: process.platform === 'win32' },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-signal-'));
      const target = path.join(root, 'target');
      fs.mkdirSync(target);
      const driver = path.join(root, 'driver.mjs');
      const leafPidFile = path.join(root, 'leaf.pid');
      fs.writeFileSync(driver, DRIVER);
      // The driver must not inherit this runner's test-child context.
      const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
      const run = spawn(process.execPath, ['--import', 'tsx', driver], {
        cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
        env: { ...env, HARNESS: harness, TARGET: target, LEAF_PID: leafPidFile },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      run.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      // Forwarding ends the leaf, and the driver then re-raises the hangup on
      // itself. Without forwarding the driver would wait out the 600 s leaf.
      const exit = await new Promise<NodeJS.Signals | 'timeout' | null>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 10_000);
        run.once('close', (_code, signal) => {
          clearTimeout(timer);
          resolve(signal);
        });
      });
      assert.ok(fs.existsSync(leafPidFile), `the driver did not start the leaf: ${stderr}`);
      if (exit === 'timeout') {
        run.kill('SIGKILL');
        process.kill(-Number(fs.readFileSync(leafPidFile, 'utf8')), 'SIGKILL');
      }
      assert.equal(exit, 'SIGHUP', `the driver did not end by the forwarded hangup: ${stderr}`);
      const leaf = Number(fs.readFileSync(leafPidFile, 'utf8'));
      for (let i = 0; i < 100 && alive(leaf); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const survived = alive(leaf);
      if (survived) process.kill(-leaf, 'SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(survived, false, 'the hangup did not reach the detached leaf');
    },
  );

  test(
    'a timed-out leaf whose group holds only an unreaped zombie ends without a throw',
    { skip: process.platform === 'win32' },
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-zombie-'));
      const target = path.join(root, 'target');
      fs.mkdirSync(target);
      const driver = path.join(root, 'driver.mjs');
      const mPidFile = path.join(root, 'm.pid');
      fs.writeFileSync(driver, TIMEOUT_DRIVER);
      const { NODE_TEST_CONTEXT: _testContext, ...env } = process.env;
      const run = spawn(process.execPath, ['--import', 'tsx', driver], {
        cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
        env: { ...env, HARNESS: harness, TARGET: target, LEAF: ZOMBIE_LEAF, M_PID: mPidFile },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      run.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      run.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null | 'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), 10_000);
        run.once('exit', (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      // M (and the zombie it holds) outlive the leaf by design; stop them here.
      const zombieParent = fs.existsSync(mPidFile) ? Number(fs.readFileSync(mPidFile, 'utf8')) : 0;
      if (code === 'timeout') run.kill('SIGKILL');
      if (zombieParent > 0 && alive(zombieParent)) process.kill(zombieParent, 'SIGKILL');
      fs.rmSync(root, { recursive: true, force: true });
      assert.ok(zombieParent > 0, `the leaf did not start its zombie parent: ${stderr}`);
      assert.equal(code, 0, `the driver failed: ${stderr}`);
      assert.deepEqual(JSON.parse(stdout), { timedOut: true, reaped: true });
    },
  );

  test('a spawn that throws leaves no parent-signal listener behind', async () => {
    const { acquireCheckoutLock, spawnScriptStreaming } = (await import(harness)) as {
      acquireCheckoutLock: (
        target: string,
        label: string,
      ) => { release(): void } | { message: string };
      spawnScriptStreaming: (
        script: string,
        args: string[],
        cwd: string,
        options: object,
      ) => Promise<unknown>;
    };
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-cli-signal-throw-'));
    const lock = acquireCheckoutLock(target, 'signal test');
    if ('message' in lock) throw new Error(lock.message);
    const before = parentSignals.map((signal) => process.listenerCount(signal));
    try {
      // A NUL byte in an argument makes child_process.spawn throw synchronously.
      await assert.rejects(
        spawnScriptStreaming('/bin/echo', ['a\0b'], target, { forward: 'none' }),
      );
    } finally {
      lock.release();
      fs.rmSync(target, { recursive: true, force: true });
    }
    assert.deepEqual(
      parentSignals.map((signal) => process.listenerCount(signal)),
      before,
    );
  });
});
