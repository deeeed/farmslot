import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { Methods, type NativeSessionInfo } from '@farmslot/protocol';

import { NativeSessionClient } from './client.js';
import { setup, stopNativeStack } from './durability.test-support.js';
import { decodeRequest } from './ipc.js';
import { NativeSessionManager } from './manager.js';
import { routeNativeSession } from './service.js';

test('delegated standalone attribution survives IPC, journal reload and resume without changing its owner', async () => {
  const fixture = setup();
  const client = new NativeSessionClient(fixture.root);
  const requester = { principalId: 'arthur', principalGeneration: 1 };
  let reloaded: NativeSessionManager | undefined;
  try {
    for (const principalGeneration of [-1, 1.5])
      assert.throws(
        () =>
          decodeRequest({
            method: 'create',
            owner: 'owner',
            params: { runner: 'codex', cwd: fixture.cwd },
            requester: { ...requester, principalGeneration },
          }),
        /requester/,
      );
    const created = (await routeNativeSession(
      client,
      'owner',
      Methods.NATIVE_SESSION_CREATE,
      { runner: 'codex', cwd: fixture.cwd, effort: 'high' },
      requester,
    )) as { session: NativeSessionInfo };
    assert.equal(created.session.ownerPrincipalId, 'owner');
    assert.equal(created.session.requestedByPrincipalId, 'arthur');
    assert.equal(created.session.requestedByPrincipalGeneration, 1);
    assert.equal(created.session.effort, 'high');
    await client.close('owner', created.session.id);
    reloaded = new NativeSessionManager(join(fixture.root, 'sessions'));
    const stored = reloaded.read('owner', created.session.id).session;
    assert.equal(stored.requestedByPrincipalId, 'arthur');
    assert.equal(stored.requestedByPrincipalGeneration, 1);
    const resumed = await reloaded.create(
      'owner',
      { runner: 'codex', cwd: fixture.cwd, resumeSessionId: stored.nativeSessionId },
      undefined,
      { principalId: 'another-admin', principalGeneration: 0 },
    );
    assert.equal(resumed.ownerPrincipalId, 'owner');
    assert.equal(resumed.requestedByPrincipalId, 'arthur');
    assert.equal(resumed.requestedByPrincipalGeneration, 1);
    await reloaded.close('owner', resumed.id);
  } finally {
    if (reloaded)
      for (const session of reloaded.list('owner')) await reloaded.close('owner', session.id);
    await stopNativeStack(fixture);
    fixture.restore();
  }
});
