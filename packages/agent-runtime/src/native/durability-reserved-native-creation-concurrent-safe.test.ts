import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { existsSync, mkdirSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import { setup } from './durability.test-support.js';
import { decodeRequest } from './ipc.js';
import { NativeSessionManager } from './manager.js';
import { alive } from './storage.js';

test('reserved native creation is concurrent-safe and survives journal reload without relaunch', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const params = { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd };
  try {
    const [first, second] = await Promise.all([
      manager.ensure('owner', params),
      manager.ensure('owner', params),
    ]);
    assert.equal(first.id, params.sessionId);
    assert.equal(second.id, first.id);
    assert.equal(second.generation, first.generation);
    assert.equal(second.processPid, first.processPid);
    assert.equal(manager.list('owner').length, 1);
    await assert.rejects(manager.ensure('another-owner', params), /another owner/);
    await assert.rejects(
      manager.ensure('owner', { ...params, model: 'changed' }),
      /launch configuration differs: model/,
    );
    await assert.rejects(
      manager.ensure('owner', { ...params, sessionId: '../escape' }),
      /must be a lowercase UUID/,
    );
    await assert.rejects(
      manager.ensure('owner', { ...params, sessionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' }),
      /lowercase UUID/,
    );
    const invalidResume = { ...params, resumeSessionId: first.nativeSessionId };
    await assert.rejects(manager.ensure('owner', invalidResume), /not resume/);
    for (const resumeSessionId of ['', null, first.nativeSessionId])
      assert.throws(
        () =>
          decodeRequest({
            method: 'ensure',
            owner: 'owner',
            params: { ...params, resumeSessionId },
          }),
        /Reserved sessionId is not for resume/,
      );
    await manager.close('owner', first.id);
    const reloaded = new NativeSessionManager(fixture.root);
    const retried = await reloaded.ensure('owner', params);
    assert.equal(retried.id, first.id);
    assert.equal(retried.generation, first.generation);
    assert.equal(retried.state, 'closed');
    assert.equal(retried.processStopped, true);
    assert.equal(alive(retried.processPid!), false);
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});

test('failed initial reservation remains an error on retry and never launches a process', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const params = { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd };
  const journal = join(fixture.root, `${params.sessionId}.journal`);
  // A real filesystem refusal before any runner launch. Repairing the path must not
  // turn the same host's uncertain reservation into a successful starting session.
  mkdirSync(journal);
  try {
    await assert.rejects(manager.ensure('owner', params), { code: 'EISDIR' });
    rmSync(journal, { recursive: true });
    await assert.rejects(manager.ensure('owner', params), { code: 'EISDIR' });
    const failed = manager.list('owner')[0]!;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.processPid, undefined);
    assert.equal(failed.nativeSessionId, '');
    assert.equal(existsSync(journal), false);
    const reloaded = new NativeSessionManager(fixture.root);
    assert.equal(reloaded.list('owner').length, 0, 'A failed open wrote no durable reservation');
    const created = await reloaded.ensure('owner', params);
    assert.equal(created.id, params.sessionId);
    assert.equal(created.state, 'idle');
    await reloaded.close('owner', created.id);
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});

test('an uncertain reservation fsync remains failed after retry and journal reload', async (t) => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const params = { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd };
  const fault = t.mock.method(fs, 'fsyncSync', () => {
    throw Object.assign(new Error('Reservation fsync failed'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(manager.ensure('owner', params), { code: 'EIO' });
    fault.mock.restore();
    syncBuiltinESMExports();
    assert.ok(existsSync(join(fixture.root, `${params.sessionId}.journal`)));
    await assert.rejects(manager.ensure('owner', params), { code: 'EIO' });
    const failed = manager.list('owner')[0]!;
    assert.equal(failed.state, 'failed');
    assert.equal(failed.processPid, undefined);
    const reloaded = new NativeSessionManager(fixture.root);
    const retried = await reloaded.ensure('owner', params);
    assert.equal(retried.id, params.sessionId);
    assert.equal(retried.generation, failed.generation);
    assert.equal(retried.state, 'failed');
    assert.equal(retried.processPid, undefined);
    assert.equal(retried.nativeSessionId, '');
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
    fixture.restore();
  }
});
