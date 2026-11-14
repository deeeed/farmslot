import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { alive } from './storage.js';
import { type NativeWorkerLaunch } from './worker-launch.js';

test('replayed worker cancellation cannot stop an explicitly resumed generation', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const params = { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd };
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: join(fixture.cwd, 'codex'),
    safetyTier: 'sandboxed',
    environment: { set: {}, unset: [] },
  };
  try {
    const first = await manager.ensure('owner', params, launch);
    await manager.cancelWorker('owner', first.id, launch.leaseId);
    const resumed = await manager.create(
      'owner',
      { ...params, resumeSessionId: first.nativeSessionId },
      launch,
    );
    assert.notEqual(resumed.generation, first.generation);
    for (const generation of [undefined, first.generation]) {
      const replay = await manager.cancelWorker('owner', first.id, launch.leaseId, generation);
      assert.equal(replay.generation, first.generation);
      assert.equal(manager.read('owner', first.id).session.state, 'idle');
      assert.ok(alive(resumed.processPid!));
    }
    const closed = await manager.cancelWorker(
      'owner',
      first.id,
      launch.leaseId,
      resumed.generation,
    );
    assert.equal(closed.session?.state, 'closed');
    assert.equal(closed.session?.processStopped, true);
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});
