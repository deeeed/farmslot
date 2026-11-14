// @farmslot:serial. Exercises real checkpoint recovery and OS process censuses.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { allEvents, setup, testRepository, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';

test('turn.changes follows its turn.completed in the journal, and a turn outside Git reports none', async () => {
  const fixture = setup();
  const { repo } = testRepository();
  const plain = mkdtempSync(join(tmpdir(), 'native-turn-plain-'));
  const manager = new NativeSessionManager(fixture.root);
  const git = await manager.create('owner', { runner: 'codex', cwd: repo });
  const outside = await manager.create('owner', { runner: 'codex', cwd: plain });
  // A file where the session's index directory goes: its start checkpoint fails, so the end of
  // the turn reports at once, inside the turn.completed path.
  const blocked = join(fixture.root, 'checkpoints', git.id);
  mkdirSync(dirname(blocked), { recursive: true });
  writeFileSync(blocked, '');
  try {
    await Promise.all([
      manager.send('owner', git.id, 'first', 'first'),
      manager.send('owner', outside.id, 'first', 'first'),
    ]);
    await until(() =>
      [git, outside].every((session) =>
        allEvents(manager, session.id).some((event) => event.type === 'turn.completed'),
      ),
    );
    await until(() => allEvents(manager, git.id).some((event) => event.type === 'turn.changes'));
    rmSync(blocked);
    for (const session of [git, outside]) await manager.close('owner', session.id);
    // After a host restart each history reads back in order, with no gap.
    const restarted = new NativeSessionManager(fixture.root);
    for (const session of [git, outside]) {
      const sequences = allEvents(restarted, session.id).map((event) => event.sequence);
      assert.deepEqual(
        sequences,
        sequences.map((_, index) => index + 1),
      );
    }
    const changes = allEvents(restarted, git.id).find((event) => event.type === 'turn.changes')!;
    assert.match(changes.changes!.unavailable!, /^The checkpoint before this turn failed/);
    assert.equal(
      allEvents(restarted, outside.id).some((event) => event.type === 'turn.changes'),
      false,
    );
  } finally {
    for (const item of manager.list('owner')) await manager.close('owner', item.id);
    fixture.restore();
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  }
});
