// @farmslot:serial. Uses an owned detached host and OS process cleanup.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { RUNTIME_VERSION } from '../version.js';

import {
  NativeSessionClient,
  releasedSessionsPolicy,
  withNativeHostRefreshPolicy,
} from './client.js';
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
    // A client reaching the state directory through a symlink verifies the same supervisor.
    const link = join(fixture.cwd, 'state-link');
    symlinkSync(fixture.root, link);
    const viaLink = new NativeSessionClient(link);
    viaLink.setRefreshPolicy(keepNone);

    assert.deepEqual(await viaLink.refreshStaleHost(), { refreshed: true, busy: [] });

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

/** The host as a version before the idle-runner fence would record itself. */
function olderHost(fixture: ReturnType<typeof setup>): HostIdentity {
  const hostFile = join(fixture.root, 'host.json');
  const before = readJson<HostIdentity>(hostFile);
  const older: Record<string, unknown> = { ...before, runtimeVersion: '0.0.0' };
  delete older.supportsIdleRunnerUpgrade;
  writeFileSync(hostFile, JSON.stringify(older));
  return before;
}

test('an older host without the idle-runner fence is still stopped once its sessions are idle', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  client.setRefreshPolicy(keepNone);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = olderHost(fixture);

    assert.deepEqual(await client.refreshStaleHost(), { refreshed: true, busy: [] });
    await client.warm();
    assert.notEqual(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    assert.equal((await client.inspect('owner', session.id)).state, 'failed');
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a send started in the same tick as a launch keeps an older host from being stopped', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  client.setRefreshPolicy(keepNone);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = olderHost(fixture);

    const launch = client.create('owner', { runner: 'codex', cwd: fixture.cwd });
    const sent = client.send('owner', session.id, 'same-tick', 'second');
    await assert.rejects(launch, {
      message: /Busy: 1 request\(s\) on their way to the host/,
    });
    assert.equal((await sent).submitted, true, 'the send reached the old host and ran');
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    // That answer was not reused: once the send is done, the next launch refreshes the host.
    const next = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });
    assert.notEqual(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await client.close('owner', next.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a busy result answers launches for a few seconds without a new census', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  let censuses = 0;
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    client.setRefreshPolicy(async () => {
      censuses += 1;
      return new Map([[session.id, 'kept']]);
    });
    skew(fixture);

    for (let attempt = 0; attempt < 3; attempt++)
      await assert.rejects(client.create('owner', { runner: 'codex', cwd: fixture.cwd }), {
        message: /\(kept\)/,
      });
    assert.equal(censuses, 1);
    await client.close('owner', session.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('two launches at once on an idle older-runtime host share its refresh and both start', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  client.setRefreshPolicy(keepNone);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = olderHost(fixture);

    const launched = await Promise.all([
      client.create('owner', { runner: 'codex', cwd: fixture.cwd }),
      client.create('owner', { runner: 'codex', cwd: fixture.cwd }),
    ]);

    assert.equal(launched.length, 2);
    assert.notEqual(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    for (const next of launched) await client.close('owner', next.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a torn or empty journal does not stop the census', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  client.setRefreshPolicy(keepNone);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    mkdirSync(join(fixture.root, 'sessions'), { recursive: true });
    writeFileSync(join(fixture.root, 'sessions', 'torn.journal'), '{"info":{"id":"torn"');
    writeFileSync(join(fixture.root, 'sessions', 'empty.journal'), '');
    skew(fixture);

    assert.deepEqual(await client.refreshStaleHost(), { refreshed: true, busy: [] });
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a fenced host answers a steer replayed through send, and the fence lifts if no stop follows', async () => {
  const fixture = setup({ manualTurns: true });
  process.env.FARMSLOT_NATIVE_IDLE_FENCE_MS = '500';
  const client = new NativeSessionClient(fixture.root);
  try {
    await client.warm();
    const session = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });
    await client.send('owner', session.id, 'first-turn', 'first');
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const host = readJson<HostIdentity>(join(fixture.root, 'host.json'));

    assert.deepEqual(
      await requestHost(host, { method: 'prepareUpgrade', owner: 'owner', idleRunners: true }),
      { idle: true, busy: [] },
    );
    assert.equal((await client.steer('owner', session.id, 'first-turn', 'first')).accepted, true);
    await assert.rejects(client.steer('owner', session.id, 'late-steer', 'late'), {
      code: 'NATIVE_HOST_VERSION_SKEW',
    });
    // No stop came: the fence lifts and the idle session takes input again.
    await until(async () => {
      try {
        await client.send('owner', session.id, 'after-fence', 'after');
        return true;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'NATIVE_HOST_VERSION_SKEW')
          return false;
        throw error;
      }
    });
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    await client.close('owner', session.id);
  } finally {
    delete process.env.FARMSLOT_NATIVE_IDLE_FENCE_MS;
    await stopNativeStack(fixture);
  }
});

test('a legacy host without any upgrade fence is still stopped once its sessions are idle', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  client.setRefreshPolicy(keepNone);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const hostFile = join(fixture.root, 'host.json');
    const before = readJson<HostIdentity>(hostFile);
    const legacy: Record<string, unknown> = { ...before };
    for (const key of [
      'runtimeVersion',
      'runtimeBuild',
      'supportsRuntimeUpgrade',
      'supportsIdleRunnerUpgrade',
    ])
      delete legacy[key];
    writeFileSync(hostFile, JSON.stringify(legacy));
    const journal = join(fixture.root, 'sessions', session.id + '.journal');

    assert.deepEqual(await client.refreshStaleHost(), { refreshed: true, busy: [] });
    await client.warm();
    assert.notEqual(readJson<HostIdentity>(hostFile).pid, before.pid);
    assert.equal((await client.inspect('owner', session.id)).state, 'failed');
    assert.ok(readFileSync(journal).length > 0, 'the stopped session keeps its journal');
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a fence for good is never lifted by an idle-runner fence, before or after it', async () => {
  const fixture = setup({ manualTurns: true });
  process.env.FARMSLOT_NATIVE_IDLE_FENCE_MS = '300';
  const client = new NativeSessionClient(fixture.root);
  try {
    await client.warm();
    const host = readJson<HostIdentity>(join(fixture.root, 'host.json'));
    // An idle-runner fence arms its timer; the plain fence that follows (no live runner)
    // holds for good, and so does a later idle-runner request.
    assert.deepEqual(
      await requestHost(host, { method: 'prepareUpgrade', owner: 'owner', idleRunners: true }),
      { idle: true, busy: [] },
    );
    assert.deepEqual(await requestHost(host, { method: 'prepareUpgrade', owner: 'owner' }), {
      idle: true,
    });
    assert.deepEqual(
      await requestHost(host, { method: 'prepareUpgrade', owner: 'owner', idleRunners: true }),
      { idle: true, busy: [] },
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    await assert.rejects(client.create('owner', { runner: 'codex', cwd: fixture.cwd }), {
      message: /fenced for a runtime upgrade/,
    });
  } finally {
    delete process.env.FARMSLOT_NATIVE_IDLE_FENCE_MS;
    await stopNativeStack(fixture);
  }
});

test('a service on older code than its checkout leaves the host alone and says to restart', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root, 'local', () => 'a-newer-checkout');
  client.setRefreshPolicy(keepNone);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = skew(fixture);

    await assert.rejects(client.create('owner', { runner: 'codex', cwd: fixture.cwd }), {
      message: /runs older code than its checkout: restart it/,
    });
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    assert.notEqual((await client.inspect('owner', session.id)).processStopped, true);
  } finally {
    await stopNativeStack(fixture);
  }
});

/** An execution node's client: no policy of its own, fenced idle stops only. */
const nodeClient = (fixture: ReturnType<typeof setup>, maxRunners = 6) =>
  new NativeSessionClient(fixture.root, 'local', undefined, { maxRunners });

/** A launch on a node, carrying the gateway's release list. */
const launchReleasing = (
  client: NativeSessionClient,
  fixture: ReturnType<typeof setup>,
  released: string[],
) =>
  withNativeHostRefreshPolicy(releasedSessionsPolicy('owner', new Set(released)), () =>
    client.create('owner', { runner: 'codex', cwd: fixture.cwd }),
  );

test('a node launch refreshes an older-runtime host whose idle sessions the gateway released', async () => {
  const fixture = setup({ manualTurns: true });
  const client = nodeClient(fixture);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = skew(fixture);

    const launched = await launchReleasing(client, fixture, [session.id]);

    const after = readJson<HostIdentity>(join(fixture.root, 'host.json'));
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.runtimeVersion, RUNTIME_VERSION);
    assert.equal((await client.inspect('owner', session.id)).state, 'failed');
    await client.close('owner', launched.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a node launch refused for a busy session refreshes at the next launch once it is idle', async () => {
  const fixture = setup({ manualTurns: true });
  const client = nodeClient(fixture);
  try {
    const { session } = await skewedHost(fixture, client);
    await until(async () => (await client.inspect('owner', session.id)).state === 'running');
    const before = skew(fixture);

    await assert.rejects(launchReleasing(client, fixture, [session.id]), {
      code: 'NATIVE_HOST_VERSION_SKEW',
      message: new RegExp(`A launch refreshes it once.*Busy: ${session.id} \\(running\\)`),
    });
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');

    // Within the busy memo's 5 s: a launch's own list gets a fresh census.
    const launched = await launchReleasing(client, fixture, [session.id]);
    assert.notEqual(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await client.close('owner', launched.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a node launch keeps sessions the gateway did not release and other owners’ sessions', async () => {
  const fixture = setup({ manualTurns: true });
  const client = nodeClient(fixture);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const other = await client.create('other', { runner: 'codex', cwd: fixture.cwd });
    await client.send('other', other.id, 'other-turn', 'first');
    await fixture.completeTurn();
    await until(async () => (await client.inspect('other', other.id)).state === 'idle');
    const before = skew(fixture);

    await assert.rejects(launchReleasing(client, fixture, [other.id]), {
      message: new RegExp(
        `Busy: (?=.*${session.id} \\(not released by the gateway\\))(?=.*${other.id} \\(another owner\\))`,
      ),
    });
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await client.close('owner', session.id);
    await client.close('other', other.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a node never stops an older host without the idle-runner fence', async () => {
  const fixture = setup({ manualTurns: true });
  const client = nodeClient(fixture);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = olderHost(fixture);

    await assert.rejects(launchReleasing(client, fixture, [session.id]), {
      message: /Busy: the host predates the idle-runner fence/,
    });
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    assert.equal((await client.inspect('owner', session.id)).state, 'idle');
    await client.close('owner', session.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a node launch stops no more idle runners than its limit', async () => {
  const fixture = setup({ manualTurns: true });
  const client = nodeClient(fixture, 0);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = skew(fixture);

    await assert.rejects(launchReleasing(client, fixture, [session.id]), {
      message: /Busy: 1 idle runner, more than the 0 a launch may stop: close some/,
    });
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await client.close('owner', session.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a launch to an older-runtime host that also lacks a capability is refused as skew', async () => {
  const fixture = setup({ manualTurns: true });
  const client = new NativeSessionClient(fixture.root);
  try {
    const { session } = await skewedHost(fixture, client);
    const hostFile = join(fixture.root, 'host.json');
    const recorded = readFileSync(hostFile, 'utf8');
    const older: Record<string, unknown> = { ...readJson<HostIdentity>(hostFile) };
    older.runtimeVersion = '0.0.0';
    delete older.conversationStreaming;
    writeFileSync(hostFile, JSON.stringify(older));

    await assert.rejects(client.create('owner', { runner: 'codex', cwd: fixture.cwd }), {
      code: 'NATIVE_HOST_VERSION_SKEW',
      message: /conversation streaming before launching new work\./,
    });
    // The real host still serves reads its faked record lacks.
    writeFileSync(hostFile, recorded);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    await client.close('owner', session.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('two node launches at once share one refresh and both start on the new host', async () => {
  const fixture = setup({ manualTurns: true });
  const client = nodeClient(fixture);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = skew(fixture);

    const first = launchReleasing(client, fixture, [session.id]);
    const second = launchReleasing(client, fixture, [session.id]);
    const launched = await first;
    const refreshed = readJson<HostIdentity>(join(fixture.root, 'host.json')).pid;
    const other = await second;

    assert.notEqual(refreshed, before.pid);
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, refreshed);
    for (const id of [launched.id, other.id])
      assert.notEqual((await client.inspect('owner', id)).processStopped, true);
    await client.close('owner', launched.id);
    await client.close('owner', other.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a node launch that waited for another refresh is refused rather than use its older list', async () => {
  const fixture = setup({ manualTurns: true });
  const client = nodeClient(fixture);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = skew(fixture);

    // The first launch's census is held until the second has arrived and is waiting.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let censusStarted!: () => void;
    const inCensus = new Promise<void>((resolve) => (censusStarted = resolve));
    const keeping = withNativeHostRefreshPolicy(
      async (sessions) => {
        censusStarted();
        await held;
        return releasedSessionsPolicy('owner', new Set())(sessions);
      },
      () => client.create('owner', { runner: 'codex', cwd: fixture.cwd }),
    );
    await inCensus;
    // It reads the running refresh in the same tick, so it is already waiting.
    const waiting = launchReleasing(client, fixture, [session.id]);
    release();

    await assert.rejects(keeping, { message: /not released by the gateway/ });
    await assert.rejects(waiting, { message: /another refresh ran while this launch waited/ });
    assert.equal(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);

    // The next launch sends a fresh list.
    const launched = await launchReleasing(client, fixture, [session.id]);
    assert.notEqual(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await client.close('owner', launched.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a node launch without a list does not hold the refresh of one that has a list', async () => {
  const fixture = setup({ manualTurns: true });
  const client = nodeClient(fixture);
  try {
    const { session } = await skewedHost(fixture, client);
    await fixture.completeTurn();
    await until(async () => (await client.inspect('owner', session.id)).state === 'idle');
    const before = skew(fixture);

    const plain = client.create('owner', { runner: 'codex', cwd: fixture.cwd });
    const listed = launchReleasing(client, fixture, [session.id]);

    await assert.rejects(plain, { code: 'NATIVE_HOST_VERSION_SKEW' });
    const launched = await listed;
    assert.notEqual(readJson<HostIdentity>(join(fixture.root, 'host.json')).pid, before.pid);
    await client.close('owner', launched.id);
  } finally {
    await stopNativeStack(fixture);
  }
});
