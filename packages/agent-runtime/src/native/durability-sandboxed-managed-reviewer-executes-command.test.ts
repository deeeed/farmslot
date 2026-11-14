import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { setup, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { readJson } from './storage.js';

test('sandboxed managed reviewer executes its command without requesting approval', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  try {
    const session = await manager.ensure(
      'owner',
      {
        sessionId: randomUUID(),
        runner: 'codex',
        cwd: fixture.cwd,
      },
      {
        leaseId: randomUUID(),
        executable: './codex',
        safetyTier: 'sandboxed',
        approvalPolicy: 'never',
        environment: { set: {}, unset: [] },
      },
    );
    const { params } = readJson<{ params: { approvalPolicy: string; sandbox: string } }>(
      join(fixture.cwd, 'native-start.json'),
    );
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.sandbox, 'workspace-write');
    await manager.send('owner', session.id, randomUUID(), 'review-command');
    await until(() => existsSync(join(fixture.cwd, 'effects')));
    assert.equal(readFileSync(join(fixture.cwd, 'effects'), 'utf8'), 'review-command\n');
    assert.equal(manager.read('owner', session.id).pendingRequests.length, 0);
  } finally {
    try {
      for (const session of manager.list('owner')) await manager.close('owner', session.id);
    } finally {
      fixture.restore();
    }
  }
});
