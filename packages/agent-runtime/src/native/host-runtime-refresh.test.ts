// @farmslot:serial. Uses an owned detached host and OS process cleanup.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { RUNTIME_VERSION } from '../version.js';

import { NativeSessionClient } from './client.js';
import { setup, stopNativeStack, until } from './durability.test-support.js';
import { type HostIdentity, requestHost } from './ipc.js';
import { readJson } from './storage.js';

/** A client on a running host whose recorded runtime no longer matches this one. */
async function skewedHost(fixture: ReturnType<typeof setup>, client: NativeSessionClient) {
  await client.warm();
  const session = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });
  await client.send('owner', session.id, 'first-turn', 'first');
  return { session, skew: () => skew(fixture) };
}

function skew(fixture: ReturnType<typeof setup>): HostIdentity {
  const hostFile = join(fixture.root, 'host.json');
  const before = readJson<HostIdentity>(hostFile);
  writeFileSync(hostFile, JSON.stringify({ ...before, runtimeVersion: '0.0.0' }));
  return before;
}

const keepNone = async () => new Map<string, string>();

test('a host on an older runtime whose live sessions are idle refreshes; they wait for resume', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  client.setRefreshPolicy(keepNone);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const saved = await client.inspect('owner', session.id);
    assert.notEqual(saved.processStopped, true, 'the idle runner is still live');
    const journal = join(fixture.root, 'sessions', session.id + '.journal');
    const before = skew(fixture);

    assert.deepEqual(await client.refreshStaleHost(), { refreshed: true, busy: [] });

    // No host runs until the next launch, which starts the current runtime.
    const next = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });
    const after = readJson<HostIdentity>(join(fixture.root, 'host.json'));
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.runtimeVersion, RUNTIME_VERSION);
    const restored = await client.inspect('owner', session.id);
    assert.equal(restored.state, 'failed');
    assert.match(restored.recovery ?? '', /explicitly resume the saved native identity/);
    assert.equal(restored.nativeSessionId, saved.nativeSessionId);
    assert.ok(readFileSync(journal).length > 0, 'the stopped session keeps its journal');
    // Its next use resumes the saved identity on the new host.
    const resumed = await client.create('owner', {
      runner: 'codex',
      cwd: fixture.cwd,
      resumeSessionId: saved.nativeSessionId,
    });
    assert.equal(resumed.nativeSessionId, saved.nativeSessionId);
    await client.close('owner', resumed.id);
    await client.close('owner', next.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a launch on an older-runtime host with only idle sessions refreshes it instead of failing', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  client.setRefreshPolicy(keepNone);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = skew(fixture);

    const launched = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });

    assert.notEqual(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await client.close('owner', launched.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a host with a turn in flight keeps running, and the launch error names the session', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  client.setRefreshPolicy(keepNone);
  try {
    const { session } = await skewedHost(fixture, client);
    await until(async () => (await client.inspect('owner', session.id)).state === 'running');
    const before = skew(fixture);

    const result = await client.refreshStaleHost();
    assert.equal(result.refreshed, false);
    assert.deepEqual(result.busy, [`${session.id} (running)`]);
    await assert.rejects(client.create('owner', { runner: 'codex', cwd: fixture.cwd }), {
      code: 'NATIVE_HOST_VERSION_SKEW',
      message: new RegExp(`Busy: ${session.id} \\(running\\)`),
    });
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    await client.close('owner', session.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('an idle session the policy keeps holds the host, and the launch error names why', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    client.setRefreshPolicy(async (sessions) => {
      assert.deepEqual(
        sessions.map((live) => live.id),
        [session.id],
      );
      return new Map([[session.id, 'dev worker of run 2137ec52']]);
    });
    const before = skew(fixture);

    await assert.rejects(client.create('owner', { runner: 'codex', cwd: fixture.cwd }), {
      message: new RegExp(`Busy: ${session.id} \\(dev worker of run 2137ec52\\)`),
    });
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await client.close('owner', session.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('without a refresh policy an idle live session still holds the host', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = skew(fixture);

    assert.deepEqual(await client.refreshStaleHost(), { refreshed: false, busy: [] });
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await client.close('owner', session.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a refresh counts every owner’s sessions, and concurrent callers share it', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  const census: string[][] = [];
  client.setRefreshPolicy(async (sessions) => {
    census.push(sessions.map((session) => session.ownerPrincipalId).sort());
    return new Map<string, string>();
  });
  try {
    await client.warm();
    for (const owner of ['owner-a', 'owner-b']) {
      const session = await client.create(owner, { runner: 'codex', cwd: fixture.cwd });
      await client.send(owner, session.id, `turn-${owner}`, 'first');
      await fixture.completeTurn();
      await until(async () => (await client.inspect(owner, session.id)).state === 'idle');
    }
    const before = skew(fixture);

    const [first, second] = [client.refreshStaleHost(), client.refreshStaleHost()];
    assert.equal(first, second, 'one refresh serves both callers');
    assert.deepEqual(await first, { refreshed: true, busy: [] });
    assert.deepEqual(census, [['owner-a', 'owner-b']]);
    await client.warm();
    assert.notEqual(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a fenced host takes no new input, so nothing starts between its census and its stop', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  try {
    await client.warm();
    const session = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });
    await client.send('owner', session.id, 'first-turn', 'first');
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const host = readJson<HostIdentity>(join(fixture.root, 'host.json'));
    assert.equal(host.supportsIdleRunnerUpgrade, true);

    assert.deepEqual(
      await requestHost(host, { method: 'prepareUpgrade', owner: 'owner', idleRunners: true }),
      { idle: true, busy: [] },
    );
    await assert.rejects(client.send('owner', session.id, 'late-turn', 'late'), {
      code: 'NATIVE_HOST_VERSION_SKEW',
    });
    // An earlier command is still answered, so a lost reply can be reconciled.
    assert.equal((await client.send('owner', session.id, 'first-turn', 'first')).accepted, true);
  } finally {
    await stopNativeStack(fixture);
  }
});
