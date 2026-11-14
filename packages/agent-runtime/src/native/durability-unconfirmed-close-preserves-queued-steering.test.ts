import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { appendDurable } from './storage.js';

test('an unconfirmed close preserves queued steering and a confirmed close cancels it', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
    await manager.close('owner', session.id);
    const stopped = manager.read('owner', session.id).session;
    const journal = join(fixture.root, `${session.id}.journal`);
    const entries = readFileSync(journal, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const entry = JSON.parse(line);
        delete entry.processes;
        delete entry.processesAdded;
        return entry;
      });
    entries.push({
      info: { ...stopped, state: 'failed', processStopped: false },
      commands: [
        {
          commandId: 'retained-steering',
          text: 'keep this instruction',
          generation: stopped.generation,
          state: 'pending',
          queued: true,
          submitted: false,
          accepted: false,
        },
      ],
    });
    writeFileSync(journal, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const restored = new NativeSessionManager(fixture.root);
    await assert.rejects(restored.close('owner', session.id), /cleanup is unconfirmed/);
    assert.equal(
      new NativeSessionManager(fixture.root).read('owner', session.id).commands[0]?.queued,
      true,
    );
    appendDurable(journal, { info: stopped });
    const confirmed = new NativeSessionManager(fixture.root);
    await confirmed.close('owner', session.id);
    const command = new NativeSessionManager(fixture.root).read('owner', session.id).commands[0];
    assert.equal(command?.queued, false);
    assert.equal(command?.outcome, 'interrupted');
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});
