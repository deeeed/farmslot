// @farmslot:serial. Uses an owned detached host and OS process cleanup.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { RUNTIME_VERSION } from '../version.js';

import { NativeSessionClient } from './client.js';
import { setup, stopNativeStack, until } from './durability.test-support.js';
import { type HostIdentity } from './ipc.js';
import { readJson } from './storage.js';
import { decodeNativeWorkerLaunch } from './worker-launch.js';

test('warm refreshes an idle mismatched host and preserves its retained conversation journal', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  try {
    await client.warm();
    const session = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });
    await client.send('owner', session.id, 'materialized-turn', 'first-review');
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    await client.close('owner', session.id);
    const saved = await client.inspect('owner', session.id);
    assert.ok(saved.nativeSessionId);
    const journal = join(fixture.root, 'sessions', session.id + '.journal');
    const bytes = readFileSync(journal);
    const hostFile = join(fixture.root, 'host.json');
    const before = readJson<HostIdentity>(hostFile);
    writeFileSync(hostFile, JSON.stringify({ ...before, runtimeVersion: '0.0.0' }));
    await client.warm();
    const after = readJson<HostIdentity>(hostFile);
    assert.notEqual(after.pid, before.pid, 'an idle host must not retain the previous runtime');
    assert.equal(readJson<Record<string, unknown>>(hostFile).runtimeVersion, RUNTIME_VERSION);
    assert.deepEqual(readFileSync(journal), bytes, 'refresh does not rewrite retained sessions');
    const restored = await client.inspect('owner', session.id);
    assert.equal(restored.nativeSessionId, saved.nativeSessionId);
    assert.equal(restored.generation, saved.generation);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('busy legacy host stays alive and readable while version-skew admissions fail before IPC', async () => {
  const fixture = setup();
  const client = new NativeSessionClient(fixture.root);
  try {
    await client.warm();
    const session = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });
    const hostFile = join(fixture.root, 'host.json');
    const before = readJson<HostIdentity>(hostFile);
    const legacy: Record<string, unknown> = { ...before };
    delete legacy.runtimeVersion;
    writeFileSync(hostFile, JSON.stringify(legacy));
    await assert.rejects(client.warm(), { code: 'NATIVE_HOST_VERSION_SKEW' });
    assert.equal(readJson<HostIdentity>(hostFile).pid, before.pid);
    assert.equal((await client.inspect('owner', session.id)).id, session.id);
    await assert.rejects(
      client.ensureWorker(
        'owner',
        { sessionId: randomUUID(), runner: 'codex', cwd: fixture.cwd },
        {
          leaseId: randomUUID(),
          safetyTier: 'sandboxed',
          environment: { set: {}, unset: [] },
          reviewerEnvironmentKeys: ['CODEX_HOME'],
        },
      ),
      /Native host runtime version skew/,
    );
    await client.close('owner', session.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('unsupported launch fields identify the key without including its value', () => {
  assert.throws(
    () =>
      decodeNativeWorkerLaunch({
        leaseId: randomUUID(),
        safetyTier: 'sandboxed',
        environment: { set: {}, unset: [] },
        unexpectedLaunchFlag: 'do-not-log-this-value',
      }),
    { message: 'Unsupported native worker launch field: unexpectedLaunchFlag' },
  );
});
