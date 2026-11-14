import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { registerQuestionModeTransfer } from './durability-question-mode.test-support.js';
import { NativeSessionManager } from './manager.js';
import { type NativeWorkerLaunch } from './worker-launch.js';

registerQuestionModeTransfer(['off', 'on']);

test('cancelling an initial worker reservation prevents a delayed launch and survives reload', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const params = { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd };
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: join(fixture.cwd, 'codex'),
    safetyTier: 'sandboxed',
    environment: { set: {}, unset: [] },
  };
  const pending = manager.ensure('owner', params, launch);
  try {
    assert.equal(
      (await manager.cancelWorker('owner', params.sessionId, launch.leaseId)).cancelled,
      true,
    );
    await assert.rejects(pending, /cancelled before launch/);
    assert.equal(existsSync(join(fixture.cwd, 'native-start.json')), false);
    assert.equal(manager.list('owner').length, 0);
    const reloaded = new NativeSessionManager(fixture.root);
    await assert.rejects(reloaded.ensure('owner', params, launch), /cancelled before launch/);
    await assert.rejects(
      reloaded.cancelWorker('other', params.sessionId, launch.leaseId),
      /another owner/,
    );
  } finally {
    await Promise.allSettled([pending]);
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});
