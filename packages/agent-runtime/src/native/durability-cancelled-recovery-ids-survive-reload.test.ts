import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { alive } from './storage.js';
import { type NativeWorkerLaunch } from './worker-launch.js';

test('cancelled recovery IDs survive reload while a new explicit recovery remains available', async () => {
  const fixture = setup();
  let manager = new NativeSessionManager(fixture.root);
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: join(fixture.cwd, 'codex'),
    safetyTier: 'sandboxed',
    environment: { set: {}, unset: [] },
  };
  try {
    const first = await manager.ensure(
      'owner',
      { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd },
      launch,
    );
    await manager.closeWorker('owner', first.id, first.generation, launch.leaseId);
    const params = {
      sessionId: first.id,
      generation: first.generation,
      runner: 'codex',
      cwd: fixture.cwd,
      resumeSessionId: first.nativeSessionId,
    };
    const cancelledIds = [randomUUID(), randomUUID()];
    for (const commandId of cancelledIds)
      await manager.cancelWorker(
        'owner',
        first.id,
        launch.leaseId,
        first.generation,
        undefined,
        commandId,
      );
    manager = new NativeSessionManager(fixture.root);
    for (const commandId of cancelledIds)
      await assert.rejects(
        manager.resumeWorker('owner', { ...params, commandId }, launch),
        /operation was cancelled/,
      );
    const resumed = await manager.resumeWorker(
      'owner',
      { ...params, commandId: randomUUID() },
      launch,
    );
    assert.notEqual(resumed.generation, first.generation);
    for (const commandId of cancelledIds) {
      await manager.cancelWorker(
        'owner',
        first.id,
        launch.leaseId,
        first.generation,
        undefined,
        commandId,
      );
      assert.equal(manager.read('owner', first.id).session.generation, resumed.generation);
      assert.ok(alive(resumed.processPid!));
    }
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});
