// @farmslot:serial. Gates a real Git checkpoint and owns its native child.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import test from 'node:test';

import { NativeCheckpoints } from './checkpoint.js';
import { allEvents, setup, testRepository, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';

test('upgrade waits for final turn changes after the native runner exits', async (t) => {
  const fixture = setup();
  const { repo } = testRepository();
  const manager = new NativeSessionManager(fixture.root);
  const take = NativeCheckpoints.prototype.take;
  let count = 0;
  let blocked = false;
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(NativeCheckpoints.prototype, 'take', async function (this: NativeCheckpoints) {
    count += 1;
    if (count === 2) {
      blocked = true;
      await released;
    }
    return take.call(this);
  });
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd: repo });
    await manager.send('owner', session.id, 'review-turn', 'review');
    await until(() => blocked);
    const pid = session.processPid;
    assert.ok(pid);
    process.kill(pid, 'SIGTERM');
    await until(() => manager.read('owner', session.id).session.processStopped === true);
    assert.equal(
      manager.prepareUpgrade(),
      false,
      'stopped process still owns an unfinished turn-history write',
    );
    assert.ok(!allEvents(manager, session.id).some((event) => event.type === 'turn.changes'));
    assert.ok(release);
    release();
    await until(() =>
      allEvents(manager, session.id).some(
        (event) => event.type === 'turn.changes' && event.commandId === 'review-turn',
      ),
    );
    assert.equal(
      manager.prepareUpgrade(),
      true,
      'history is durable before the upgrade fence seals admission',
    );
  } finally {
    release?.();
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
    rmSync(repo, { recursive: true, force: true });
  }
});
