import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setup, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { alive } from './storage.js';

test('while a request waits for an answer, a steered message is queued instead', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
  try {
    await manager.send('owner', session.id, 'approval', 'approval');
    await until(() => manager.read('owner', session.id).pendingRequests.length > 0);
    const queued = await manager.steer('owner', session.id, 'later', 'later');
    assert.equal(queued.queued, true);
    assert.equal(queued.steered, undefined);
    assert.equal(existsSync(join(fixture.cwd, 'steers')), false);
  } finally {
    for (const item of manager.list('owner')) await manager.close('owner', item.id);
    fixture.restore();
  }
});

test('a steer whose runner stopped before replying stays unknown, and is never resent', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
  const receipt = () =>
    manager.read('owner', session.id).commands.find((command) => command.commandId === 'exit');
  try {
    await manager.send('owner', session.id, 'first', 'first');
    await until(() => manager.read('owner', session.id).session.state === 'running');
    // The runner exits with a tool child still running: the reply is lost, not a refusal.
    assert.equal((await manager.steer('owner', session.id, 'exit', 'exit')).state, 'unknown');
    await until(() =>
      ['closed', 'failed'].includes(manager.read('owner', session.id).session.state),
    );
    assert.deepEqual([receipt()?.state, receipt()?.steered], ['unknown', true]);
    assert.equal(readFileSync(join(fixture.cwd, 'steers'), 'utf8'), 'exit\n');
    const reloaded = new NativeSessionManager(fixture.root)
      .read('owner', session.id)
      .commands.find((command) => command.commandId === 'exit');
    assert.equal(reloaded?.state, 'unknown');
  } finally {
    // The tool child outlives its runner here; never leave it running.
    const descendant = join(fixture.cwd, 'descendant');
    const pid = existsSync(descendant) ? Number(readFileSync(descendant, 'utf8')) : 0;
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    for (const item of manager.list('owner')) await manager.close('owner', item.id);
    fixture.restore();
  }
});
