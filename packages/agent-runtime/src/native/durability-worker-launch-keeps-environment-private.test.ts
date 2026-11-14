import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

import { setup, until } from './durability.test-support.js';
import { NativeSessionManager } from './manager.js';
import { readJson } from './storage.js';
import { decodeNativeWorkerLaunch, type NativeWorkerLaunch } from './worker-launch.js';

test('worker launch keeps environment private and transfers only an idle task lease', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const secret = `private-environment-${randomUUID()}`;
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: './codex',
    effort: 'high',
    safetyTier: 'full-auto',
    environment: { set: { NATIVE_WORKER_PROBE: secret }, unset: [] },
  };
  const params = { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd };
  try {
    assert.throws(
      () => decodeNativeWorkerLaunch({ ...launch, futurePermissionFlag: true }),
      /Unsupported/,
    );
    const session = await manager.ensure('owner', params, launch);
    assert.equal(session.workerManaged, true);
    assert.equal(session.workerLeaseId, launch.leaseId);
    const firstStream = manager
      .conversation('owner', session.id, launch.leaseId, session.generation)
      .resume();
    assert(firstStream.kind === 'reset');
    assert.equal(firstStream.snapshot.session.capabilities.cancelQueued, true);
    const started = readJson<{
      params: { approvalPolicy: string; sandbox: string };
      env: Record<string, string>;
    }>(join(fixture.cwd, 'native-start.json'));
    assert.deepEqual(started.env, { probe: secret, omc: '1', omx: '1' });
    assert.equal(started.params.approvalPolicy, 'never');
    assert.equal(started.params.sandbox, 'workspace-write');
    const next = { ...launch, leaseId: randomUUID() };
    await manager.send('owner', session.id, randomUUID(), 'approval');
    assert.equal(
      readJson<{ effort: string }>(join(fixture.cwd, 'native-turn.json')).effort,
      'high',
    );
    await until(() => manager.read('owner', session.id).pendingRequests.length > 0);
    assert.throws(
      () => manager.transferWorker('owner', session.id, session.generation, launch.leaseId, next),
      /idle session/,
    );
    await manager.respond(
      'owner',
      session.id,
      manager.read('owner', session.id).pendingRequests[0]!.request!.id,
      { decision: 'deny' },
    );
    await until(() => manager.read('owner', session.id).session.state === 'idle');
    assert.throws(
      () =>
        manager.transferWorker('owner', session.id, session.generation, launch.leaseId, {
          ...next,
          safetyTier: 'dangerous',
        }),
      /preserve generation and launch configuration/,
    );
    const handedOff = manager.transferWorker(
      'owner',
      session.id,
      session.generation,
      launch.leaseId,
      next,
    );
    assert.equal(handedOff.workerLeaseId, next.leaseId);
    assert.equal(handedOff.processPid, session.processPid);
    assert.equal(
      manager.transferWorker('owner', session.id, session.generation, launch.leaseId, next)
        .workerLeaseId,
      next.leaseId,
    );
    assert.throws(
      () => manager.assertWorkerLease('owner', session.id, session.generation, launch.leaseId),
      /task lease changed/,
    );
    await assert.rejects(manager.ensure('owner', params, launch), /another worker task lease/);
    manager.assertWorkerLease('owner', session.id, session.generation, next.leaseId);
    assert.equal((await manager.ensure('owner', params, next)).processPid, session.processPid);
    assert.equal(
      readFileSync(join(fixture.root, `${session.id}.journal`), 'utf8').includes(secret),
      false,
    );
    await manager.close('owner', session.id);
    await assert.rejects(
      manager.create('owner', {
        runner: 'codex',
        cwd: fixture.cwd,
        resumeSessionId: session.nativeSessionId,
      }),
      /Worker recovery requires/,
    );
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});

test('uncertain worker lease persistence refuses input until explicit close and recovery', async (t) => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: join(fixture.cwd, 'codex'),
    safetyTier: 'sandboxed',
    environment: { set: {}, unset: [] },
  };
  const params = { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd };
  const session = await manager.ensure('owner', params, launch);
  const next = { ...launch, leaseId: randomUUID() };
  const fault = t.mock.method(fs, 'fsyncSync', () => {
    throw new Error('Lease flush failed');
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => manager.transferWorker('owner', session.id, session.generation, launch.leaseId, next),
      /Lease flush failed/,
    );
    fault.mock.restore();
    syncBuiltinESMExports();
    assert.throws(
      () => manager.assertWorkerLease('owner', session.id, session.generation, next.leaseId),
      /Lease flush failed/,
    );
    assert.throws(
      () => manager.transferWorker('owner', session.id, session.generation, launch.leaseId, next),
      /Lease flush failed/,
    );
    await assert.rejects(manager.ensure('owner', params, next), /Lease flush failed/);
    manager.assertWorkerLease('owner', session.id, session.generation, next.leaseId, true);
    await manager.close('owner', session.id);
    const reloaded = new NativeSessionManager(fixture.root);
    const closed = await reloaded.ensure('owner', params, next);
    assert.equal(closed.state, 'closed');
    assert.equal(closed.workerLeaseId, next.leaseId);
  } finally {
    fault.mock.restore();
    syncBuiltinESMExports();
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});
