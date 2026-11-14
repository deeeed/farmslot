// @farmslot:serial. Drives live native process trees through queued turns.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setup, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';

test('a steered message joins the running turn, ends with it, and never holds up the queue', async () => {
  const fixture = setup({ manualTurns: true });
  const manager = new NativeSessionManager(fixture.root);
  const receipt = (commandId: string) =>
    manager.read('owner', session.id).commands.find((command) => command.commandId === commandId);
  const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
  try {
    assert.equal(session.capabilities.steer, true);
    // No turn runs: steering is an ordinary send, which starts one.
    assert.equal((await manager.steer('owner', session.id, 'first', 'first')).steered, undefined);
    await until(() => manager.read('owner', session.id).session.state === 'running');
    assert.deepEqual(await manager.steer('owner', session.id, 'more', 'more'), {
      commandId: 'more',
      submitted: true,
      accepted: true,
      state: 'accepted',
      steered: true,
    });
    // Durable before the runner got it: the submission precedes the runner's acceptance.
    const events = manager.read('owner', session.id).events;
    const at = (type: string) =>
      events.findIndex((event) => event.type === type && event.commandId === 'more');
    assert.ok(at('command.submitted') >= 0 && at('command.submitted') < at('command.accepted'));
    assert.equal((await manager.send('owner', session.id, 'next', 'next')).queued, true);
    await fixture.completeTurn();
    const inputs = join(fixture.cwd, 'inputs');
    await until(() => existsSync(inputs) && readFileSync(inputs, 'utf8').includes('next'));
    assert.deepEqual(
      ['first', 'more'].map((id) => [receipt(id)?.state, receipt(id)?.steered]),
      [
        ['completed', undefined],
        ['completed', true],
      ],
    );
    assert.equal(readFileSync(inputs, 'utf8'), 'first\nnext\n');
    // A runner refusal fails the message, and it is never resent.
    await until(() => manager.read('owner', session.id).session.state === 'running');
    assert.equal((await manager.steer('owner', session.id, 'refuse', 'refuse')).state, 'failed');
    assert.equal(
      (await manager.steer('owner', session.id, 'refuse', 'refuse')).state,
      'failed',
      'a retry returns the receipt',
    );
    await fixture.completeTurn();
    await until(() => manager.read('owner', session.id).session.state === 'idle');
    assert.equal(readFileSync(join(fixture.cwd, 'steers'), 'utf8'), 'more\nrefuse\n');
    assert.equal(readFileSync(inputs, 'utf8'), 'first\nnext\n');
  } finally {
    for (const item of manager.list('owner')) await manager.close('owner', item.id);
    fixture.restore();
  }
});
