// @farmslot:serial. Drives native generation recovery and OS process censuses.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setup, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { matchesProcess } from './storage.js';

test('linear journal, durable uncertain receipt, exact recovery and stale generation decisions', async () => {
  const fixture = setup({ manualTurns: true });
  const { cwd, root } = fixture;
  let manager = new NativeSessionManager(root);
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd });
    await manager.send('owner', session.id, 'long', 'long-prompt-marker');
    await fixture.completeTurn();
    await until(() => manager.read('owner', session.id).session.state === 'idle');
    const journal = readFileSync(join(root, `${session.id}.journal`), 'utf8');
    const submittedEntry = journal
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event?.type === 'command.submitted');
    assert.equal(submittedEntry.commands[0].state, 'unknown');
    assert.equal(submittedEntry.commands[0].submitted, true);
    assert.ok(
      journal
        .trim()
        .split('\n')
        .every((line) => Object.keys(JSON.parse(line)).length > 0),
    );
    assert.ok(
      journal.split('long-prompt-marker').length < 10,
      'Stream events repeated prompt history',
    );
    await manager.send('owner', session.id, 'long', 'long-prompt-marker');
    const submitted = manager
      .read('owner', session.id, 0, 500)
      .events.filter((event) => event.type === 'command.submitted');
    assert.equal(submitted.length, 1);
    assert.equal(submitted[0]?.text, 'long-prompt-marker');
    assert.equal(submitted[0]?.commandId, 'long');
    const page = manager.read('owner', session.id, 0, 17);
    assert.equal(page.events.length, 17);
    assert.equal(page.cursor, 17);
    assert.equal(page.hasMore, true);
    assert.throws(() => manager.read('owner', session.id, 0, 501), /limit/);
    assert.equal(manager.read('owner', session.id, 17, 17).events[0]?.sequence, 18);
    await manager.send('owner', session.id, 'pending-approval', 'approval');
    await until(() => manager.read('owner', session.id).pendingRequests.length === 1);
    const request = manager.read('owner', session.id).pendingRequests[0]!;
    assert.notEqual(request.request!.id, request.nativeId);
    await assert.rejects(
      manager.respond('other', session.id, request.request!.id, { decision: 'approve' }),
      /not found/,
    );
    await assert.rejects(
      manager.respond('owner', session.id, request.nativeId!, { decision: 'approve' }),
      /stale/,
    );
    await manager.close('owner', session.id);
    assert.equal(manager.read('owner', session.id).session.processStopped, true);
    assert.equal(
      matchesProcess(process.pid, manager.read('owner', session.id).session.processIdentity!),
      false,
    );
    manager = new NativeSessionManager(root);
    const resumed = await manager.create('owner', {
      runner: 'codex',
      cwd,
      resumeSessionId: session.nativeSessionId,
    });
    assert.equal(resumed.id, session.id);
    assert.notEqual(resumed.generation, session.generation);
    assert.equal(
      (await manager.send('owner', session.id, 'long', 'long-prompt-marker')).state,
      'completed',
    );
    await manager.send('owner', session.id, 'new-approval', 'approval');
    await until(() => manager.read('owner', session.id).pendingRequests.length === 1);
    await assert.rejects(
      manager.respond('owner', session.id, request.request!.id, { decision: 'approve' }),
      /stale/,
    );
    const current = manager.read('owner', session.id).pendingRequests[0]!;
    await manager.respond('owner', session.id, current.request!.id, { decision: 'deny' });
    await until(() => manager.read('owner', session.id).session.state === 'idle');
    await assert.rejects(
      manager.send('owner', session.id, 'uncertain', 'unknown'),
      /exited|closed/,
    );
    await until(() => manager.read('owner', session.id).session.state === 'failed');
    manager = new NativeSessionManager(root);
    assert.equal(
      (await manager.send('owner', session.id, 'uncertain', 'unknown')).state,
      'unknown',
    );
    await manager.create('owner', {
      runner: 'codex',
      cwd,
      resumeSessionId: session.nativeSessionId,
    });
    assert.equal(
      (await manager.send('owner', session.id, 'uncertain', 'unknown')).state,
      'unknown',
    );
    assert.equal(
      readFileSync(join(cwd, 'inputs'), 'utf8')
        .split('\n')
        .filter((line) => line === 'unknown').length,
      1,
    );
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});
