import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { alive } from './storage.js';
import { type NativeWorkerLaunch } from './worker-launch.js';

test('a stopped worker transfers its lease before resuming the saved conversation', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const params = { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd };
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: join(fixture.cwd, 'codex'),
    safetyTier: 'full-auto',
    environment: { set: {}, unset: [] },
  };
  const successor = { ...launch, leaseId: randomUUID() };
  try {
    const first = await manager.ensure('owner', params, launch);
    await manager.cancelWorker('owner', first.id, launch.leaseId, first.generation);
    const transferred = manager.transferWorker(
      'owner',
      first.id,
      first.generation,
      launch.leaseId,
      successor,
    );
    assert.equal(transferred.processStopped, true);
    assert.equal(transferred.generation, first.generation);
    assert.equal(transferred.workerLeaseId, successor.leaseId);
    assert.throws(
      () => manager.assertWorkerLease('owner', first.id, first.generation, launch.leaseId),
      /lease changed/,
    );
    const resumed = await manager.create(
      'owner',
      { ...params, resumeSessionId: first.nativeSessionId },
      successor,
    );
    assert.equal(resumed.nativeSessionId, first.nativeSessionId);
    assert.notEqual(resumed.generation, first.generation);
    await manager.cancelWorker('owner', first.id, launch.leaseId, first.generation);
    assert.ok(alive(resumed.processPid!));
    assert.equal(manager.read('owner', first.id).session.workerLeaseId, successor.leaseId);
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});
