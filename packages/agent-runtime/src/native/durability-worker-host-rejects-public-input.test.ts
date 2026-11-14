import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { Methods } from '@farmslot/protocol';

import { NativeSessionClient } from './client.js';
import { setup, until } from './durability.test-support.js';
import { type HostIdentity, socketDirectory } from './ipc.js';
import { routeNativeSession } from './service.js';
import { alive, readJson } from './storage.js';
import { NATIVE_WORKER_CANCEL_COMMAND, type NativeWorkerLaunch } from './worker-launch.js';
import { routeNativeWorkerSession } from './worker-service.js';

test('worker host rejects public input and accepts only leased commands and permission replies', async () => {
  const fixture = setup();
  const client = new NativeSessionClient(fixture.root);
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: join(fixture.cwd, 'codex'),
    safetyTier: 'sandboxed',
    environment: { set: {}, unset: [] },
  };
  try {
    const session = await client.ensureWorker(
      'owner',
      { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd },
      launch,
    );
    const target = {
      sessionId: session.id,
      generation: session.generation,
      leaseId: launch.leaseId,
    };
    // Trusted farm dispatch, monitoring and recovery read through the shared service.
    const snapshot = await routeNativeSession(client, 'owner', Methods.NATIVE_SESSION_READ, {
      sessionId: session.id,
      limit: 1,
    });
    assert(snapshot && typeof snapshot === 'object');
    assert.equal(Reflect.get(snapshot, 'session').workerManaged, true);
    await assert.rejects(
      client.send('owner', session.id, 'unleased', 'approval'),
      /requires its run context/,
    );
    await assert.rejects(client.interrupt('owner', session.id), /requires its run context/);
    await assert.rejects(client.close('owner', session.id), /requires its run context/);
    await assert.rejects(
      client.sendWorker('owner', { ...target, leaseId: randomUUID() }, 'stale', 'approval'),
      /lease changed/,
    );
    assert.equal(existsSync(join(fixture.cwd, 'inputs')), false);
    await client.sendWorker('owner', target, 'leased-approval', 'approval');
    assert.equal((await client.sendWorker('owner', target, 'removed', 'removed')).queued, true);
    const removal = { sessionId: session.id, commandId: 'removed' };
    await assert.rejects(
      routeNativeSession(client, 'owner', Methods.NATIVE_SESSION_CANCEL, removal),
      /requires its run context/,
    );
    await assert.rejects(
      client.cancelCommandWorker('owner', { ...target, leaseId: randomUUID() }, 'removed'),
      /lease changed/,
    );
    const leased = { ...removal, generation: session.generation, leaseId: launch.leaseId };
    assert.deepEqual(
      await routeNativeWorkerSession(client, 'owner', NATIVE_WORKER_CANCEL_COMMAND, leased),
      {
        receipt: {
          commandId: 'removed',
          generation: session.generation,
          state: 'failed',
          queued: false,
          submitted: false,
          accepted: false,
          outcome: 'cancelled',
        },
      },
    );
    await until(async () => (await client.read('owner', session.id)).pendingRequests.length === 1);
    const pending = (await client.read('owner', session.id)).pendingRequests[0]!.request!.id;
    await assert.rejects(
      client.respond('owner', session.id, pending, { decision: 'approve' }),
      /requires its run context/,
    );
    await assert.rejects(
      client.respondWorker('owner', { ...target, generation: randomUUID() }, pending, {
        decision: 'approve',
      }),
      /generation.*changed/,
    );
    assert.equal((await client.read('owner', session.id)).pendingRequests.length, 1);
    await client.respondWorker('owner', target, pending, { decision: 'deny' });
    await until(async () => (await client.read('owner', session.id)).session.state === 'idle');
    assert.equal(readFileSync(join(fixture.cwd, 'inputs'), 'utf8'), 'approval\n');
    assert.equal((await client.closeWorker('owner', target)).processStopped, true);
  } finally {
    const file = join(fixture.root, 'host.json');
    if (existsSync(file)) {
      const host = readJson<HostIdentity>(file);
      if (alive(host.pid)) {
        process.kill(host.pid, 'SIGTERM');
        await until(() => !alive(host.pid));
      }
    }
    rmSync(socketDirectory(fixture.root), { recursive: true, force: true });
    fixture.restore();
  }
});
