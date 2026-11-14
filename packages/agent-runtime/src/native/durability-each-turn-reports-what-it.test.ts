import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { allEvents, setup, testRepository, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';

test('each turn reports what it changed in its Git working tree, and close drops its checkpoints', async () => {
  const fixture = setup();
  const { repo, git } = testRepository();
  const manager = new NativeSessionManager(fixture.root);
  const session = await manager.create('owner', { runner: 'codex', cwd: repo });
  const refs = () =>
    git('for-each-ref', '--format=%(refname)', `refs/farmslot/native/${session.id}/`).trim();
  // The turn streams hundreds of deltas: read every page.
  const events = () => allEvents(manager, session.id);
  try {
    await manager.send('owner', session.id, 'first', 'first');
    await until(() => events().some((event) => event.type === 'turn.changes'));
    const event = events().find((item) => item.type === 'turn.changes')!;
    assert.equal(event.commandId, 'first');
    // What the runner wrote during the turn; the file it wrote before the turn is not the turn's.
    assert.deepEqual(event.changes!.files.map((file) => [file.path, file.status]).sort(), [
      ['descendant', 'added'],
      ['effects', 'added'],
      ['inputs', 'added'],
      ['native-turn.json', 'added'],
    ]);
    assert.ok(event.changes!.from && event.changes!.to);
    // The reader's index and HEAD never moved.
    assert.equal(git('diff', '--cached', '--name-only'), '');
    assert.equal(git('rev-list', '--count', 'HEAD').trim(), '1');
    assert.notEqual(refs(), '');
    await manager.close('owner', session.id);
    assert.equal(refs(), '');
  } finally {
    for (const item of manager.list('owner')) await manager.close('owner', item.id);
    fixture.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});
