import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';

import { NativeSessionClient } from './client.js';
import { setup } from './durability.test-support.js';
import { socketDirectory } from './ipc.js';
import { NativeSessionManager } from './manager.js';
import { alive, appendDurable, privateDirectory } from './storage.js';
import { type NativeWorkerLaunch } from './worker-launch.js';

test('old native hosts retain ordinary reads but refuse ensured creation before IPC', async () => {
  const fixture = setup();
  const socketRoot = socketDirectory(fixture.root);
  privateDirectory(fixture.root);
  privateDirectory(socketRoot);
  const socket = join(socketRoot, 'legacy');
  const requests: string[] = [];
  const server = createServer({ allowHalfOpen: true }, (peer) => {
    let input = '';
    peer.on('data', (chunk) => {
      input += chunk.toString();
    });
    peer.on('end', () => {
      requests.push(JSON.parse(input).request.method);
      peer.end(JSON.stringify({ value: [] }));
    });
  });
  server.listen(socket);
  await once(server, 'listening');
  writeFileSync(
    join(fixture.root, 'host.json'),
    JSON.stringify({ pid: process.pid, socket, token: 'fixture-token' }),
    { mode: 0o600 },
  );
  writeFileSync(join(fixture.root, 'ready.json'), '{}', { mode: 0o600 });
  try {
    const client = new NativeSessionClient(fixture.root);
    assert.deepEqual(await client.list('owner'), []);
    await assert.rejects(
      client.ensure('owner', { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd }),
      /host upgrade required/,
    );
    await assert.rejects(
      client.create(
        'owner',
        { runner: 'codex', cwd: fixture.cwd },
        { principalId: 'person', principalGeneration: 1 },
      ),
      /host upgrade required for standalone requester/,
    );
    assert.deepEqual(requests, ['list']);
    await assert.rejects(
      client.ensureWorker(
        'owner',
        { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd },
        {
          leaseId: randomUUID(),
          safetyTier: 'sandboxed',
          environment: { set: {}, unset: [] },
        },
      ),
      /host upgrade required for worker launch/,
    );
    assert.deepEqual(requests, ['list']);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(socketRoot, { recursive: true, force: true });
    fixture.restore();
  }
});

test('legacy recovery and terminal close require descendant evidence even when the wrapper is gone', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd });
    await manager.close('owner', session.id);
    const stopped = manager.read('owner', session.id).session;
    assert.equal(stopped.processStopped, true);
    assert.equal(alive(stopped.processPid!), false);
    // Legacy records have no durable descendant identities. A missing wrapper
    // alone cannot establish cleanup of an unobserved detached child.
    const journal = join(fixture.root, `${session.id}.journal`);
    writeFileSync(
      journal,
      readFileSync(journal, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const entry = JSON.parse(line);
          delete entry.processes;
          delete entry.processesAdded;
          return JSON.stringify(entry);
        })
        .join('\n') + '\n',
    );
    appendDurable(join(fixture.root, `${session.id}.journal`), {
      info: { ...stopped, state: 'failed', processStopped: false },
    });
    const recovered = new NativeSessionManager(fixture.root);
    await assert.rejects(recovered.close('owner', session.id), /cleanup is unconfirmed/);
    await assert.rejects(
      recovered.create('owner', {
        runner: 'codex',
        cwd: fixture.cwd,
        resumeSessionId: session.nativeSessionId,
      }),
      /cleanup is unconfirmed/,
    );
  } finally {
    for (const session of manager.list('owner')) await manager.close('owner', session.id);
    fixture.restore();
  }
});

test('legacy worker cleanup can be explicitly attested without discarding its conversation', async () => {
  const fixture = setup();
  const manager = new NativeSessionManager(fixture.root);
  const launch: NativeWorkerLaunch = {
    leaseId: randomUUID(),
    executable: join(fixture.cwd, 'codex'),
    safetyTier: 'full-auto',
    environment: { set: {}, unset: [] },
  };
  let restored: NativeSessionManager | undefined;
  try {
    const session = await manager.create('owner', { runner: 'codex', cwd: fixture.cwd }, launch);
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
      info: { ...stopped, state: 'failed', processStopped: false, processStopReason: undefined },
    });
    writeFileSync(journal, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    restored = new NativeSessionManager(fixture.root);
    assert.equal(restored.read('owner', session.id).session.processStopped, false);
    await assert.rejects(
      () => restored!.confirmWorkerStopped('owner', session.id, 'stale', launch.leaseId),
      /generation or task lease changed/,
    );
    const confirmed = await restored.confirmWorkerStopped(
      'owner',
      session.id,
      session.generation,
      launch.leaseId,
    );
    assert.equal(confirmed.processStopped, true);
    assert.equal(confirmed.processStopReason, 'process-missing-attested');
    const cursor = restored.read('owner', session.id).cursor;
    await restored.confirmWorkerStopped('owner', session.id, session.generation, launch.leaseId);
    assert.equal(restored.read('owner', session.id).cursor, cursor);
    const resumed = await restored.create(
      'owner',
      { runner: 'codex', cwd: fixture.cwd, resumeSessionId: session.nativeSessionId },
      launch,
    );
    assert.equal(resumed.nativeSessionId, session.nativeSessionId);
    assert.notEqual(resumed.generation, session.generation);
  } catch (error) {
    console.error(`Legacy attestation regression: ${(error as Error).message}`);
    throw error;
  } finally {
    for (const session of (restored ?? manager).list('owner')) {
      if (!session.processStopped && session.processPid && !alive(session.processPid)) continue;
      await (restored ?? manager).close('owner', session.id);
    }
    fixture.restore();
  }
});

test('a torn first journal write cannot reserve input ownership or prevent host startup', () => {
  const fixture = setup();
  try {
    mkdirSync(fixture.root, { mode: 0o700 });
    const journal = join(fixture.root, 'unstarted.journal');
    writeFileSync(journal, '{"info":', { mode: 0o600 });
    assert.deepEqual(new NativeSessionManager(fixture.root).list('owner'), []);
    assert.equal(readFileSync(journal, 'utf8'), '');
  } finally {
    fixture.restore();
  }
});
