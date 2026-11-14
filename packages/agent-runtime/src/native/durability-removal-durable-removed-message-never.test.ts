import assert from 'node:assert/strict';
import fs, { existsSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import { setup, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';

test('a removal is durable, and the removed message never reaches the runner', async (t) => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
    const removed = (reader: NativeSessionManager) =>
      reader.read('owner', session.id).commands.find((command) => command.commandId === 'removed');
    await manager.send('owner', session.id, 'running', 'running');
    assert.equal((await manager.send('owner', session.id, 'removed', 'removed')).queued, true);
    assert.equal((await manager.send('owner', session.id, 'kept', 'kept')).queued, true);
    // A removal its journal did not record fails and leaves the message queued.
    const fault = t.mock.method(fs, 'openSync', () => {
      throw Object.assign(new Error('Journal append failed'), { code: 'EIO' });
    });
    syncBuiltinESMExports();
    try {
      assert.throws(() => manager.cancelCommand('owner', session.id, 'removed'), { code: 'EIO' });
    } finally {
      fault.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(removed(manager)?.queued, true);
    assert.equal(manager.cancelCommand('owner', session.id, 'removed').outcome, 'cancelled');
    assert.throws(() => manager.cancelCommand('owner', session.id, 'running'), /no longer queued/);
    // A retried send of the removed message returns its receipt instead of queueing it again.
    assert.deepEqual(await manager.send('owner', session.id, 'removed', 'removed'), {
      commandId: 'removed',
      state: 'failed',
      submitted: false,
      accepted: false,
    });
    const inputs = join(fixture.cwd, 'inputs');
    await until(() => existsSync(inputs) && readFileSync(inputs, 'utf8').includes('kept'));
    assert.equal(readFileSync(inputs, 'utf8'), 'running\nkept\n');
    assert.throws(() => manager.cancelCommand('owner', session.id, 'kept'), /no longer queued/);
    // The journal holds the removal, so a restarted host never submits it either.
    await manager.close('owner', session.id);
    const reloaded = removed(new NativeSessionManager(fixture.root));
    assert.equal(reloaded?.outcome, 'cancelled');
    assert.equal(reloaded?.queued, false);
    assert.equal(reloaded?.submitted, false);
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});
