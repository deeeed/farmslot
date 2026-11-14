import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { alive } from './storage.js';
import { type NativeWorkerLaunch } from './worker-launch.js';

test('cancelling a reserved handoff fences a delayed transfer and preserves later task leases', async () => {
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
    const session = await manager.ensure('owner', params, launch);
    await assert.rejects(
      manager.cancelWorker(
        'other',
        session.id,
        successor.leaseId,
        session.generation,
        launch.leaseId,
      ),
      /ownership changed/,
    );
    assert.equal(manager.read('owner', session.id).session.workerLeaseId, launch.leaseId);
    const cancel = manager.cancelWorker(
      'owner',
      session.id,
      successor.leaseId,
      session.generation,
      launch.leaseId,
    );
    const delayed = manager.transferWorker(
      'owner',
      session.id,
      session.generation,
      launch.leaseId,
      successor,
    );
    assert.equal(delayed.workerLeaseId, successor.leaseId);
    const stopped = await cancel;
    assert.equal(stopped.session?.processStopped, true);
    assert.equal(stopped.session?.state, 'closed');
    const retried = await manager.ensure('owner', params, successor);
    assert.equal(retried.state, 'closed');
    assert.equal(retried.processPid, session.processPid);
    assert.equal(
      (await new NativeSessionManager(fixture.root).ensure('owner', params, successor)).state,
      'closed',
    );
    const resumed = await manager.create(
      'owner',
      { ...params, resumeSessionId: session.nativeSessionId },
      successor,
    );
    const later = { ...successor, leaseId: randomUUID() };
    manager.transferWorker('owner', session.id, resumed.generation, successor.leaseId, later);
    await assert.rejects(
      manager.cancelWorker(
        'owner',
        session.id,
        successor.leaseId,
        resumed.generation,
        launch.leaseId,
      ),
      /ownership changed/,
    );
    assert.equal(manager.read('owner', session.id).session.workerLeaseId, later.leaseId);
    assert.ok(alive(resumed.processPid!));
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});
