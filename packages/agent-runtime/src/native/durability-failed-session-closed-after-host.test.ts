import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setup, testRepository, until } from './durability.test-support.js';
import { decodeRequest } from './ipc.js';
import { NativeSessionManager } from './manager.js';
import { NATIVE_WORKER_STEER } from './worker-launch.js';

test('a failed session closed after a host restart deletes its checkpoints', async () => {
  const fixture = setup();
  const { repo, git } = testRepository();
  const manager = new NativeSessionManager(fixture.root);
  const session = await manager.create('owner', { runner: 'codex', cwd: repo });
  const refs = () =>
    git('for-each-ref', '--format=%(refname)', `refs/farmslot/native/${session.id}/`).trim();
  try {
    // The runner dies in the turn, after its start checkpoint; the session fails, process stopped.
    await assert.rejects(manager.send('owner', session.id, 'unknown', 'unknown'), /exited|closed/);
    await until(() => {
      const { state, processStopped } = manager.read('owner', session.id).session;
      return state === 'failed' && processStopped === true;
    });
    assert.notEqual(refs(), '');
    // Restored after a restart, the session has no checkpoints open; closing it finds them.
    await new NativeSessionManager(fixture.root).close('owner', session.id);
    assert.equal(refs(), '');
    assert.equal(existsSync(join(fixture.root, 'checkpoints', session.id)), false);
  } finally {
    for (const item of manager.list('owner')) await manager.close('owner', item.id);
    fixture.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('host IPC decodes a steered message, leased for a worker', () => {
  const steer = { owner: 'owner', id: 'session', commandId: 'more', text: 'Also check the tests.' };
  assert.deepEqual(decodeRequest({ method: 'steer', ...steer }), { method: 'steer', ...steer });
  const lease = { generation: 'generation', leaseId: 'lease' };
  assert.deepEqual(decodeRequest({ method: NATIVE_WORKER_STEER, ...steer, ...lease }), {
    method: NATIVE_WORKER_STEER,
    ...steer,
    ...lease,
  });
  assert.throws(
    () => decodeRequest({ method: NATIVE_WORKER_STEER, ...steer, generation: 'generation' }),
    /Invalid IPC leaseId/,
  );
});
