import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { alive, appendDurable } from './storage.js';
import { type NativeWorkerLaunch } from './worker-launch.js';

test('legacy stop attestation distinguishes a positively owned replacement generation from an unknown group', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: join(fixture.cwd, 'codex'),
    safetyTier: 'full-auto',
    environment: { set: {}, unset: [] },
  };
  const foreign = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  assert.ok(foreign.pid);
  try {
    const original = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd }, launch);
    await manager.close('owner', original.id);
    const stopped = manager.read('owner', original.id).session;
    const journal = join(fixture.root, `${original.id}.journal`);
    const entries = readFileSync(journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line);
        delete entry.processes;
        delete entry.processesAdded;
        return entry;
      });
    entries.push({
      info: { ...stopped, state: 'failed', processStopped: false, processPid: foreign.pid },
    });
    writeFileSync(journal, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const unknown = new NativeSessionManager(fixture.root);
    assert.throws(
      () => unknown.confirmWorkerStopped('owner', original.id, original.generation, launch.leaseId),
      /absent native process and process group/,
    );
    assert.equal(alive(foreign.pid), true);
    const replacement = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
    appendDurable(journal, {
      info: {
        ...stopped,
        state: 'failed',
        processStopped: false,
        processPid: replacement.processPid,
      },
    });
    const restored = new NativeSessionManager(fixture.root);
    const confirmed = restored.confirmWorkerStopped(
      'owner',
      original.id,
      original.generation,
      launch.leaseId,
    );
    assert.equal(confirmed.processStopReason, 'process-missing-attested');
    assert.equal(
      alive(replacement.processPid!),
      true,
      'Attestation must never signal the replacement generation',
    );
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    const exited = once(foreign, 'exit');
    foreign.kill('SIGTERM');
    await exited;
    fixture.restore();
  }
});
