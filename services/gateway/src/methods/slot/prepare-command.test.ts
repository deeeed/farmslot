import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SlotVars } from '../../core/index.js';

import { clearStalePrepareProcess } from './prepare-command.js';

// Local slot: execOnSlot runs the cleanup script via execLocal (bash -c) on this
// host, so the kill-detection path exercises the real shell + PID-liveness marker
// contract that recovery relies on. projectName/slotId are deliberately unique so
// the always-on fallback patterns match nothing on the test machine.
function localVars(): SlotVars {
  return {
    host: 'localhost',
    machine: 'localhost',
    remoteRepo: os.tmpdir(),
    projectName: `no-such-project-${randomUUID()}`,
    slotId: `no-such-slot-${randomUUID()}`,
  } as unknown as SlotVars;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('clearStalePrepareProcess returns true and kills the tracked in-flight preflight', async () => {
  // The tracked-PID branch fires only when the pid is alive AND its command
  // looks like a preflight. Pass a `preflight.sh` path as $0 so it shows up in
  // the process command line; the while-loop keeps bash from exec-optimising and
  // dropping that argv.
  const child = spawn(
    'bash',
    ['-c', 'while :; do sleep 1; done', '/tmp/farmslot-test/setup/preflight.sh'],
    { stdio: 'ignore' },
  );
  child.unref();
  const pidFile = path.join(os.tmpdir(), `farmslot-preflight-test-${randomUUID()}.pid`);
  await writeFile(pidFile, String(child.pid), 'utf-8');

  let killed: boolean;
  try {
    await delay(300); // let the child be visible to ps/kill
    killed = await clearStalePrepareProcess(localVars(), pidFile, 'test', []);
  } finally {
    if (isAlive(child.pid)) {
      try {
        process.kill(child.pid!, 'SIGKILL');
      } catch {
        // best-effort: process may already be gone
      }
    }
  }

  assert.equal(killed, true);
  await delay(200);
  assert.equal(isAlive(child.pid), false, 'tracked preflight should be terminated');
});

test('clearStalePrepareProcess returns false when there is no live tracked preflight', async () => {
  // Missing pid file: the tracked-PID branch is skipped and the fallback sweep
  // matches nothing real, so no kill is reported. This guards against the
  // fallback sweep self-signalling a kill under `bash -c`.
  const pidFile = path.join(os.tmpdir(), `farmslot-preflight-test-${randomUUID()}.pid`);

  const killed = await clearStalePrepareProcess(localVars(), pidFile, 'test', [
    `no-match-pattern-${randomUUID()}`,
  ]);

  assert.equal(killed, false);
});
