import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { NativeSessionClient } from './client.js';
import { setup, stopNativeStack } from './durability.test-support.js';
import { type HostIdentity } from './ipc.js';
import { privateDirectory, readJson, type RecordedProcess } from './storage.js';

test('a reboot that leaves the stopped supervisor and host PIDs to other processes does not block the host', async () => {
  const fixture = setup();
  let standIn: ReturnType<typeof spawn> | undefined;
  try {
    // A reboot leaves the lock, the host record and a pending cleanup behind, and their PIDs
    // can belong to any process afterwards: here this test runner and a stand-in child.
    standIn = spawn('sleep', ['30'], { stdio: 'ignore' });
    privateDirectory(join(fixture.root, 'lock'));
    privateDirectory(join(fixture.root, 'sessions'));
    const write = (name: string, value: unknown) =>
      writeFileSync(join(fixture.root, name), JSON.stringify(value), { mode: 0o600 });
    write('lock/owner.json', { pid: process.pid, identity: 'the stopped supervisor start' });
    write('worker.json', { pid: standIn.pid, identity: 'the stopped host start' });
    write('cleanup.json', { hostPid: standIn.pid, state: 'pending' });
    await new NativeSessionClient(fixture.root).warm();
    const supervisor = readJson<HostIdentity>(join(fixture.root, 'host.json')).pid;
    assert.notEqual(supervisor, process.pid);
    assert.equal(readJson<RecordedProcess>(join(fixture.root, 'lock/owner.json')).pid, supervisor);
  } finally {
    standIn?.kill('SIGKILL');
    await stopNativeStack(fixture);
  }
});
