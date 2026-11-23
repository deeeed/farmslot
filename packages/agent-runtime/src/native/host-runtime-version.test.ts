// @farmslot:serial. Uses an owned detached host and OS process cleanup.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RUNTIME_VERSION } from '../version.js';

import { NativeSessionClient } from './client.js';
import { setup, stopNativeStack, until } from './durability.test-support.js';
import { type HostIdentity, requestHost } from './ipc.js';
import { currentRuntimeBuild, runtimeBuildIdentity } from './runtime-build.js';
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

test('busy host with unknown version stays alive and readable while admissions fail before IPC', async () => {
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

// A source deploy rebuilds agent-runtime without bumping its version (0.50.6 before and after on
// mini), so a host that loaded the old code passed the version check and kept running it: #2450's
// Claude reviewer fix stayed inert until a manual host refresh.
test('warm refreshes an idle host whose runtime build differs at the same version', async () => {
  const fixture = setup();
  const client = new NativeSessionClient(fixture.root);
  try {
    await client.warm();
    const hostFile = join(fixture.root, 'host.json');
    const before = readJson<HostIdentity>(hostFile);
    assert.equal(before.runtimeBuild, currentRuntimeBuild());
    writeFileSync(hostFile, JSON.stringify({ ...before, runtimeBuild: 'older-build' }));
    await client.warm();
    const after = readJson<HostIdentity>(hostFile);
    assert.notEqual(after.pid, before.pid, 'an idle host must not keep the previous build');
    assert.equal(after.runtimeVersion, RUNTIME_VERSION);
    assert.equal(after.runtimeBuild, currentRuntimeBuild());
  } finally {
    await stopNativeStack(fixture);
  }
});

test('a busy host on an older build stays alive while new admissions fail', async () => {
  const fixture = setup();
  const client = new NativeSessionClient(fixture.root);
  try {
    await client.warm();
    const session = await client.create('owner', { runner: 'codex', cwd: fixture.cwd });
    const hostFile = join(fixture.root, 'host.json');
    const before = readJson<HostIdentity>(hostFile);
    writeFileSync(hostFile, JSON.stringify({ ...before, runtimeBuild: 'older-build' }));
    await assert.rejects(client.warm(), { code: 'NATIVE_HOST_VERSION_SKEW' });
    assert.equal(readJson<HostIdentity>(hostFile).pid, before.pid);
    assert.equal((await client.inspect('owner', session.id)).id, session.id);
    await assert.rejects(
      client.create('owner', { runner: 'codex', cwd: fixture.cwd }),
      /Native host runtime version skew/,
    );
    await client.close('owner', session.id);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('the runtime build follows code and ignores tests', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-build-'));
  try {
    mkdirSync(join(root, 'dist', 'native'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'package.json'), '{"version":"0.50.6"}');
    writeFileSync(join(root, 'dist', 'native', 'claude.js'), 'old');
    writeFileSync(join(root, 'scripts', 'review-filesystem.cjs'), 'sandbox');
    const build = () => runtimeBuildIdentity(root, ['dist', 'scripts']);
    const first = build();
    writeFileSync(join(root, 'dist', 'native', 'claude.test.js'), 'tests are not runtime');
    writeFileSync(join(root, 'dist', 'native', 'claude.js.map'), 'maps are not runtime');
    assert.equal(build(), first);
    writeFileSync(join(root, 'dist', 'native', 'claude.js'), 'new');
    assert.notEqual(build(), first, 'changed code at the same version is a new build');
    const second = build();
    writeFileSync(join(root, 'scripts', 'review-filesystem.cjs'), 'sandbox v2');
    assert.notEqual(build(), second, 'a host-loaded script is part of the build');
  } finally {
    rmSync(root, { recursive: true, force: true });
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

test('a launch paused before reservation prevents host retirement', async () => {
  const fixture = setup();
  const client = new NativeSessionClient(fixture.root);
  let pending: Promise<unknown> | undefined;
  try {
    await client.warm();
    const binary = join(fixture.cwd, 'codex');
    writeFileSync(
      binary,
      readFileSync(binary, 'utf8').replace(
        "if (process.argv.includes('--version')) {",
        `if (process.argv.includes('--version')) {
        const gateFs = require('node:fs'); gateFs.writeFileSync('version-entered', '');
        while (!gateFs.existsSync('version-release')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
      `,
      ),
    );
    pending = client.create('owner', { runner: 'codex', cwd: fixture.cwd });
    const observed = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await until(() => existsSync(join(fixture.cwd, 'version-entered')));
    const hostFile = join(fixture.root, 'host.json');
    const before = readJson<HostIdentity>(hostFile);
    writeFileSync(hostFile, JSON.stringify({ ...before, runtimeVersion: '0.0.0' }));
    await assert.rejects(client.warm(), { code: 'NATIVE_HOST_VERSION_SKEW' });
    assert.equal(readJson<HostIdentity>(hostFile).pid, before.pid);
    writeFileSync(join(fixture.cwd, 'version-release'), '');
    const result = await observed;
    assert.ok('value' in result, 'the already-started launch must complete');
    const sessions = await client.list('owner');
    assert.equal(sessions.length, 1);
    await client.close('owner', sessions[0]!.id);
  } finally {
    writeFileSync(join(fixture.cwd, 'version-release'), '');
    if (pending) await Promise.allSettled([pending]);
    await stopNativeStack(fixture);
  }
});

test('PID-only ownership and legacy hosts without an upgrade fence remain readable', async () => {
  const fixture = setup();
  const client = new NativeSessionClient(fixture.root);
  try {
    await client.warm();
    const hostFile = join(fixture.root, 'host.json');
    const before = readJson<HostIdentity>(hostFile);
    const lockFile = join(fixture.root, 'lock/owner.json');
    const lock = readFileSync(lockFile);
    writeFileSync(hostFile, JSON.stringify({ ...before, runtimeVersion: '0.0.0' }));
    writeFileSync(lockFile, JSON.stringify({ pid: before.pid }));
    await assert.rejects(client.warm(), { code: 'NATIVE_HOST_VERSION_SKEW' });
    assert.deepEqual(await client.list('owner'), []);
    writeFileSync(lockFile, lock);
    const legacy: Record<string, unknown> = { ...before };
    delete legacy.runtimeVersion;
    delete legacy.supportsRuntimeUpgrade;
    writeFileSync(hostFile, JSON.stringify(legacy));
    await assert.rejects(client.warm(), { code: 'NATIVE_HOST_VERSION_SKEW' });
    assert.deepEqual(await client.list('owner'), []);
    assert.equal(readJson<HostIdentity>(hostFile).pid, before.pid);
  } finally {
    await stopNativeStack(fixture);
  }
});

test('an acknowledged upgrade fence refuses late admission through host IPC and keeps reads', async () => {
  const fixture = setup();
  const client = new NativeSessionClient(fixture.root);
  try {
    await client.warm();
    const host = readJson<HostIdentity>(join(fixture.root, 'host.json'));
    assert.deepEqual(await requestHost(host, { method: 'prepareUpgrade', owner: 'owner' }), {
      idle: true,
    });
    assert.deepEqual(await requestHost(host, { method: 'prepareUpgrade', owner: 'owner' }), {
      idle: true,
    });
    await assert.rejects(client.create('owner', { runner: 'codex', cwd: fixture.cwd }), {
      code: 'NATIVE_HOST_VERSION_SKEW',
    });
    assert.deepEqual(await client.list('owner'), []);
  } finally {
    await stopNativeStack(fixture);
  }
});
