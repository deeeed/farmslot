import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const packageRoot = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const source = (file: string): string =>
  JSON.stringify(new URL(`../../src/harness/${file}`, import.meta.url).href);

// Runs inside a process that may not execute `ps`. Every step used to throw the spawn error.
const DRIVER = `
import { withCommandJournal, readCommandJournal } from ${source('command-journal.ts')};
import { acquireCheckoutLock } from ${source('checkout-lock.ts')};
import { configureHarnessHost, harnessHost, hostEnvName } from ${source('host.ts')};
import { collectTaskView } from ${source('task-view.ts')};
import fs from 'node:fs';

const target = process.argv[1];
configureHarnessHost({ ...harnessHost(), journaledCommands: ['run'] });
const result = {};
result.exitCode = await withCommandJournal('run', ['run', 'smoke'], async () => {
  result.liveJournal = readCommandJournal(target).record?.verdict;
  result.ownerAlive = collectTaskView(target, undefined, Date.now()).operations.map((o) => o.ownerAlive);
  const lock = acquireCheckoutLock(target, 'run');
  if (!('release' in lock)) throw new Error(lock.message);
  result.lockOwner = JSON.parse(fs.readFileSync(lock.path, 'utf8'));
  const tokenEnv = hostEnvName('CHECKOUT_LOCK_TOKEN');
  const token = process.env[tokenEnv];
  delete process.env[tokenEnv];
  const other = acquireCheckoutLock(target, 'other');
  process.env[tokenEnv] = token;
  result.otherRefused = !('release' in other) && other.message.includes('busy');
  lock.release();
  result.lockReleased = !fs.existsSync(lock.path);
  return 0;
}, { target });
result.finalJournal = readCommandJournal(target).record?.verdict;
console.log(JSON.stringify(result));
`;

const denials: {
  name: string;
  skip: boolean;
  command: (root: string) => [string, string[], NodeJS.ProcessEnv];
}[] = [
  {
    // macOS refuses to exec the setuid /bin/ps under any sandbox profile: spawnSync ps EPERM.
    name: 'sandbox-exec (EPERM)',
    skip: process.platform !== 'darwin',
    command: () => [
      '/usr/bin/sandbox-exec',
      ['-p', '(version 1)(allow default)', process.execPath],
      process.env,
    ],
  },
  {
    // A non-executable `ps` alone on PATH: spawnSync ps EACCES.
    name: 'unexecutable ps (EACCES)',
    skip: process.platform === 'win32' || process.getuid?.() === 0,
    command: (root) => {
      const bin = path.join(root, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      return [process.execPath, [], { ...process.env, PATH: bin }];
    },
  },
];

for (const denial of denials) {
  test(
    `journal, task view and checkout lock work when ps is denied: ${denial.name}`,
    { skip: denial.skip },
    (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-identity-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const target = path.join(root, 'target');
      fs.mkdirSync(target);
      const [file, prefix, env] = denial.command(root);
      // The driver must not inherit this runner's test-child context.
      const { NODE_TEST_CONTEXT: _testContext, ...inherited } = env;
      const childEnv = { ...inherited, TSX_TSCONFIG_PATH: path.join(packageRoot, 'tsconfig.json') };
      const result = spawnSync(
        file,
        [...prefix, '--import', 'tsx', '--input-type=module', '-e', DRIVER, target],
        {
          cwd: packageRoot,
          env: childEnv,
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /journal unavailable|EPERM|EACCES/);
      const observed = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
      assert.equal(observed.exitCode, 0);
      // The running operation is this live process, even though its start time is unknown.
      assert.equal(observed.liveJournal, 'running');
      assert.deepEqual(observed.ownerAlive, [true]);
      // No identity is recorded rather than a guessed one; a live owner is never reclaimed.
      assert.equal(observed.lockOwner.processStartedAt, undefined);
      assert.equal(observed.otherRefused, true);
      assert.equal(observed.lockReleased, true);
      assert.equal(observed.finalJournal, 'pass');
    },
  );
}
