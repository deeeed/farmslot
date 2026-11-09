import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { acquireCheckoutLock } from '../src/harness/checkout-lock.js';
import { readCommandJournal, withCommandJournal } from '../src/harness/command-journal.js';
import { configureHarnessHost, harnessHost, hostEnvName } from '../src/harness/host.js';
import { collectTaskView } from '../src/harness/task-view.js';

// Inside the worker sandbox macOS refuses to exec the setuid /bin/ps (spawnSync ps EPERM);
// a non-executable ps gives EACCES. test/live/sandbox-process-identity.test.mts runs the real sandbox.
for (const code of ['EPERM', 'EACCES']) {
  test(`journal, task view and checkout lock work when ps fails with ${code}`, async (t) => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-identity-'));
    const previous = harnessHost();
    const execFileSync = childProcess.execFileSync;
    t.mock.method(childProcess, 'execFileSync', (file: string, ...rest: unknown[]) => {
      if (file === 'ps')
        throw Object.assign(new Error(`spawnSync ps ${code}`), { code, syscall: 'spawnSync ps' });
      return (execFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      configureHarnessHost(previous);
      fs.rmSync(target, { recursive: true, force: true });
    });
    configureHarnessHost({ ...previous, journaledCommands: ['run'] });
    const stderr: string[] = [];
    t.mock.method(process.stderr, 'write', (chunk: string) => {
      stderr.push(String(chunk));
      return true;
    });
    const tokenEnv = hostEnvName('CHECKOUT_LOCK_TOKEN');
    const inheritedToken = process.env[tokenEnv];
    delete process.env[tokenEnv];
    t.after(() => {
      if (inheritedToken) process.env[tokenEnv] = inheritedToken;
    });

    let observed: Record<string, unknown> = {};
    const exitCode = await withCommandJournal(
      'run',
      ['run', 'smoke'],
      async () => {
        const lock = acquireCheckoutLock(target, 'run');
        assert.ok('release' in lock, 'message' in lock ? lock.message : 'lock refused');
        const owner = JSON.parse(fs.readFileSync(lock.path, 'utf8'));
        const token = process.env[tokenEnv];
        delete process.env[tokenEnv];
        const other = acquireCheckoutLock(target, 'other');
        process.env[tokenEnv] = token;
        lock.release();
        observed = {
          liveJournal: readCommandJournal(target).record?.verdict,
          ownerAlive: collectTaskView(target, undefined, Date.now()).operations.map(
            (operation) => operation.ownerAlive,
          ),
          ownerStartedAt: owner.processStartedAt,
          otherRefused: !('release' in other) && other.message.includes('busy'),
          lockReleased: !fs.existsSync(lock.path),
        };
        return 0;
      },
      { target },
    );

    assert.equal(exitCode, 0);
    assert.doesNotMatch(stderr.join(''), /journal unavailable|EPERM|EACCES/);
    // The running operation is this live process, even though its start time is unknown.
    assert.equal(observed.liveJournal, 'running');
    assert.deepEqual(observed.ownerAlive, [true]);
    // No identity is recorded rather than a guessed one; a live owner is never reclaimed.
    assert.equal(observed.ownerStartedAt, undefined);
    assert.equal(observed.otherRefused, true);
    assert.equal(observed.lockReleased, true);
    assert.equal(readCommandJournal(target).record?.verdict, 'pass');
  });
}
