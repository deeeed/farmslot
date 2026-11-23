import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { delay, setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { alive } from './storage.js';
import { type NativeWorkerLaunch } from './worker-launch.js';

test('kernel birth evidence permits attestation without signalling a reused PID group', async () => {
  const fixtureState = setup();
  const manager = new NativeSessionManager(fixtureState.root);
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: join(fixtureState.cwd, 'codex'),
    safetyTier: 'full-auto',
    environment: { set: {}, unset: [] },
  };
  let foreign: ReturnType<typeof spawn> | undefined;
  try {
    const original = await manager.create(
      'owner',
      { runner: 'codex', cwd: fixtureState.cwd },
      launch,
    );
    await manager.close('owner', original.id);
    const stopped = manager.read('owner', original.id).session;
    // ps start identities have second precision; force a distinct real kernel birth.
    await delay(2100);
    foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    assert.ok(foreign.pid);
    const journal = join(fixtureState.root, `${original.id}.journal`);
    const entries = readFileSync(journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line);
        for (const key of ['processes', 'processesAdded'])
          for (const frame of entry[key] ?? []) {
            if (frame.pid === original.processPid) frame.pid = foreign!.pid;
            if (frame.parent === original.processPid) frame.parent = foreign!.pid;
            if (frame.group === original.processPid) frame.group = foreign!.pid;
          }
        return entry;
      });
    entries.push({
      info: { ...stopped, state: 'failed', processStopped: false, processPid: foreign.pid },
    });
    writeFileSync(journal, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const restored = new NativeSessionManager(fixtureState.root);
    const confirmed = await restored.confirmWorkerStopped(
      'owner',
      original.id,
      original.generation,
      launch.leaseId,
    );
    assert.equal(confirmed.processStopped, true);
    assert.equal(
      alive(foreign.pid),
      true,
      'Attestation must preserve the unrelated current process',
    );
  } finally {
    try {
      if (foreign?.pid && alive(foreign.pid)) {
        const exited = once(foreign, 'exit');
        foreign.kill('SIGTERM');
        await exited;
      }
    } finally {
      fixtureState.restore();
    }
  }
});
