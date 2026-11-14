import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { allEvents, setup, testRepository, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';

test("a queued message is journaled after its previous turn's changes", async () => {
  const fixture = setup();
  const { repo } = testRepository();
  const manager = new NativeSessionManager(fixture.root);
  const session = await manager.create('owner', { runner: 'codex', cwd: repo });
  const events = () => allEvents(manager, session.id);
  try {
    await manager.send('owner', session.id, 'first', 'first');
    await until(() => events().some((event) => event.type === 'turn.started'));
    assert.equal((await manager.send('owner', session.id, 'second', 'second')).queued, true);
    const at = (type: string, commandId: string) =>
      events().find((event) => event.type === type && event.commandId === commandId)?.sequence;
    await until(() => at('command.submitted', 'second') !== undefined);
    // The first turn's changes come before the queued message, so a reader sees them under it.
    assert.ok(at('turn.changes', 'first')! < at('command.submitted', 'second')!);
  } finally {
    for (const item of manager.list('owner')) await manager.close('owner', item.id);
    fixture.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});
