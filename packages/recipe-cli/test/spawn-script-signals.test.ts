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
  await spawnScriptStreaming('/bin/sleep', ['30'], process.env.TARGET, { forward: 'none' });
} finally {
  lock.release();
}
`;

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
      await new Promise((resolve) => run.once('close', resolve));
      assert.ok(fs.existsSync(leafPidFile), `the driver did not start the leaf: ${stderr}`);
      const leaf = Number(fs.readFileSync(leafPidFile, 'utf8'));
      for (let i = 0; i < 100 && alive(leaf); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const survived = alive(leaf);
      if (survived) process.kill(-leaf, 'SIGKILL');
      assert.equal(survived, false, 'the hangup did not reach the detached leaf');
    },
  );
});
