import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { NativeProfileStatusResult } from '@farmslot/protocol';

import { observeNodeNativeAccount } from './native-account.js';
import { NativeNodeSessions } from './native-session.js';

test('node native execution rejects other owners and conflicting execution identities before startup', async () => {
  const service = new NativeNodeSessions('node-a', 'owner', '/unused-native-test');
  assert.deepEqual(service.declaration, {
    ownerPrincipalId: 'owner',
    supportsStandaloneDelegation: true,
    conversationStreaming: 1,
    supportsApprovalMode: true,
    supportsEnsure: true,
    supportsWorkers: true,
    supportsProfiles: true,
    supportsWorkerStopAttestation: true,
    supportsStructuredResults: true,
    supportsHostRefresh: true,
    supportsSessionArchive: true,
    supportsObservations: true,
    supportsObservationConfiguration: true,
    supportsInitialObservationConfiguration: true,
  });
  await assert.rejects(
    service.route({
      owner: 'owner',
      method: 'native.session.create',
      params: {},
      hostRelease: 'all',
    }),
    /hostRelease must be a list of session IDs/,
  );
  await assert.rejects(
    service.route({ owner: 'another', method: 'native.session.list', params: {} }),
    /not owned/,
  );
  await assert.rejects(
    service.route({
      owner: 'owner',
      method: 'native.session.list',
      params: { executionNodeId: 'node-b' },
    }),
    /another execution node/,
  );
  assert.throws(() => new NativeNodeSessions('local', 'owner'), /distinct node/);
});

test('native target metadata reports its actual home and refuses an old ready host without exposing IPC secrets', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-target-metadata-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new NativeNodeSessions('fixture-machine', 'owner', root);
  assert.deepEqual(service.metadata('owner'), {
    homeDirectory: os.homedir(),
    supportsStandaloneDelegation: true,
    supportsWorkerCompaction: true,
  });
  assert.throws(() => service.metadata('other'), /not owned/);
  const hostRoot = path.join(root, 'nodes/fixture-machine');
  mkdirSync(hostRoot, { recursive: true });
  const socket = path.join(root, 'fixture-socket');
  writeFileSync(socket, '');
  writeFileSync(path.join(hostRoot, 'ready.json'), '{}');
  const secret = 'fixture-private-ipc-secret';
  writeFileSync(
    path.join(hostRoot, 'host.json'),
    JSON.stringify({ executionNodeId: 'fixture-machine', pid: process.pid, socket, token: secret }),
    { mode: 0o600 },
  );
  const old = service.metadata('owner');
  assert.equal(old.supportsStandaloneDelegation, false);
  assert.equal(old.supportsWorkerCompaction, false);
  assert.equal(JSON.stringify(old).includes(secret), false);
  writeFileSync(
    path.join(hostRoot, 'host.json'),
    JSON.stringify({
      executionNodeId: 'fixture-machine',
      pid: process.pid,
      socket,
      token: secret,
      supportsStandaloneDelegation: true,
      supportsWorkerCompaction: true,
      conversationStreaming: 1,
    }),
    { mode: 0o600 },
  );
  assert.equal(service.metadata('owner').supportsStandaloneDelegation, true);
  assert.equal(service.metadata('owner').supportsWorkerCompaction, true);
});

test('run retention archive requests never start a host and need a host that archives', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-archive-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = new NativeNodeSessions('fixture-machine', 'owner', root);
  const id = '11111111-2222-4333-8444-555555555555';
  const archive = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    service.route({ owner: 'owner', method: 'native.session.archive', params, ...extra });
  for (const sessionIds of [undefined, [], Array.from({ length: 51 }, () => id), [1]])
    await assert.rejects(archive({ sessionIds }), /sessionIds must list 1-50 session IDs/);
  await assert.rejects(archive({ sessionIds: [id] }, { hostRelease: [] }), /sessionIds must list/);
  // No host: the request is refused as unavailable, and none is started for it.
  await assert.rejects(archive({ sessionIds: [id] }), /Native host unavailable/);
  const hostRoot = path.join(root, 'nodes/fixture-machine');
  assert.equal(existsSync(path.join(hostRoot, 'host.json')), false);
  // A running host on an older runtime cannot archive; it is asked again on a later pass.
  mkdirSync(hostRoot, { recursive: true });
  const socket = path.join(root, 'fixture-socket');
  writeFileSync(socket, '');
  writeFileSync(path.join(hostRoot, 'ready.json'), '{}');
  writeFileSync(
    path.join(hostRoot, 'host.json'),
    JSON.stringify({ executionNodeId: 'fixture-machine', pid: process.pid, socket, token: 'x' }),
    { mode: 0o600 },
  );
  await assert.rejects(archive({ sessionIds: [id] }), /upgrade required for session archive/);
});

test('a node start whose native host is not ready in time registers instead of exiting', async (t) => {
  const { NativeSessionClient } = await import('@farmslot/agent-runtime/native');
  const { nativeHostUnavailableError } =
    await import('@farmslot/agent-runtime/native/host-unavailable');
  t.mock.method(NativeSessionClient.prototype, 'warm', async () => {
    throw nativeHostUnavailableError('/fixture/host.log');
  });
  const warned = t.mock.method(console, 'warn', () => {});
  const service = new NativeNodeSessions('node-a', 'owner', '/unused-native-test');
  await service.prepareRuntime();
  assert.equal(warned.mock.callCount(), 1);
  assert.match(
    String(warned.mock.calls[0]?.arguments[0]),
    /not ready at node start.*\/fixture\/host\.log/,
  );
});

test('a node start still fails on a native error that is not a host-readiness one', async (t) => {
  const { NativeSessionClient } = await import('@farmslot/agent-runtime/native');
  t.mock.method(NativeSessionClient.prototype, 'warm', async () => {
    throw new Error('Native state directory belongs to another execution node');
  });
  const service = new NativeNodeSessions('node-a', 'owner', '/unused-native-test');
  await assert.rejects(service.prepareRuntime(), /another execution node/);
});

test('observeNodeNativeAccount reuses observeAntigravityAccount across auth, signed-out, exit-127 failure, missing binary, and child cleanup', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-account-observe-'));
  const pidFile = path.join(root, 'child.pid');
  const fakeAgy = path.join(root, 'agy');
  const launcherExit127 = path.join(root, 'agy-exit-127');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  writeFileSync(
    fakeAgy,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  console.log('1.5.12');
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const signedOut = process.env.AGY_TEST_SIGNED_OUT === '1';
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' } } });
  }
  if (m.method === 'session/list') {
    if (signedOut) {
      return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    }
    return send({ id: m.id, result: { sessions: [] } });
  }
});
`,
  );
  chmodSync(fakeAgy, 0o700);

  writeFileSync(
    launcherExit127,
    `#!/usr/bin/env node
if (process.argv.includes('--version')) {
  console.log('1.5.12');
  process.exit(0);
}
process.stderr.write('shared library temporarily unavailable\\n');
process.exit(127);
`,
  );
  chmodSync(launcherExit127, 0o700);

  const auth = await observeNodeNativeAccount(
    {
      runner: 'antigravity',
      cwd: '/',
      executable: fakeAgy,
    },
    async () => ({ PATH: process.env.PATH }),
  );
  assert.equal(auth.installed, true);
  assert.equal(auth.login, 'authenticated');
  assert.equal(auth.version, '1.5.12');
  // Confirm the ACP child exited before observeNodeNativeAccount resolved.
  const childPid = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });

  // Binary reachable ONLY via the node's login PATH (absent from daemon process.env.PATH and
  // with no explicit executable override) must still authenticate cleanly with host cwd '/'.
  const prevPath = process.env.PATH;
  const prevAgyEnv = process.env.FARMSLOT_AGY_EXECUTABLE;
  try {
    delete process.env.FARMSLOT_AGY_EXECUTABLE;
    process.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
    const loginPathOnly = await observeNodeNativeAccount(
      {
        runner: 'antigravity',
        cwd: '/',
      },
      async () => ({
        PATH: `${root}${path.delimiter}${path.dirname(process.execPath)}:/usr/bin:/bin`,
      }),
    );
    assert.equal(loginPathOnly.installed, true);
    assert.equal(loginPathOnly.login, 'authenticated');
    assert.equal(loginPathOnly.version, '1.5.12');
    const loginChildPid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.throws(() => process.kill(loginChildPid, 0), { code: 'ESRCH' });
  } finally {
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevAgyEnv === undefined) delete process.env.FARMSLOT_AGY_EXECUTABLE;
    else process.env.FARMSLOT_AGY_EXECUTABLE = prevAgyEnv;
  }

  const signedOut = await observeNodeNativeAccount(
    {
      runner: 'antigravity',
      cwd: '/',
      executable: fakeAgy,
      env: { AGY_TEST_SIGNED_OUT: '1' },
    },
    async () => ({ PATH: process.env.PATH }),
  );
  assert.equal(signedOut.installed, true);
  assert.equal(signedOut.login, 'signed-out');

  // An existing executable exiting 127 is a launcher failure, never not-installed or signed-out.
  const exit127 = await observeNodeNativeAccount(
    {
      runner: 'antigravity',
      cwd: '/',
      executable: launcherExit127,
    },
    async () => ({ PATH: process.env.PATH }),
  );
  assert.equal(exit127.installed, true);
  assert.equal(exit127.login, 'unavailable');
  assert.notEqual(exit127.reason, 'not-installed');

  const missing = await observeNodeNativeAccount(
    {
      runner: 'antigravity',
      cwd: '/',
      executable: path.join(root, 'no-such-agy'),
    },
    async () => ({ PATH: process.env.PATH }),
  );
  assert.equal(missing.installed, false);
  assert.equal(missing.reason, 'not-installed');
});

test('node observation configures trusted executables before reads and serves repeated reads from cache', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-observed-agy-'));
  const farmHome = path.join(root, 'farm-home');
  const stateRoot = path.join(root, 'state');
  const nodeDir = path.join(stateRoot, 'nodes', 'remote-agy-node');
  const profileDir = path.join(root, 'work-profile');
  const probeLog = path.join(root, 'probes.log');
  const fakeAgyV1 = path.join(root, 'custom-bin-v1', 'agy');
  const fakeAgyV2 = path.join(root, 'custom-bin-v2', 'agy');
  mkdirSync(farmHome, { recursive: true });
  mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
  chmodSync(nodeDir, 0o700);
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(path.dirname(fakeAgyV1), { recursive: true });
  mkdirSync(path.dirname(fakeAgyV2), { recursive: true });
  const writeFakeAgy = (target: string, version: string) => {
    writeFileSync(
      target,
      `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  fs.appendFileSync(${JSON.stringify(probeLog)}, ${JSON.stringify(`${version}\n`)});
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: ${JSON.stringify(version)} } } });
  }
  if (m.method === 'session/list') {
    return send({ id: m.id, result: { sessions: [] } });
  }
});
`,
    );
    chmodSync(target, 0o700);
  };
  writeFakeAgy(fakeAgyV1, '1.5.12');
  writeFakeAgy(fakeAgyV2, '1.5.13');

  const prevFarmHome = process.env.FARMSLOT_HOME;
  const prevPath = process.env.PATH;
  const prevAgyEnv = process.env.FARMSLOT_AGY_EXECUTABLE;
  const service = new NativeNodeSessions('remote-agy-node', 'owner', stateRoot);
  t.after(() => {
    service.stopObservation();
    if (prevFarmHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = prevFarmHome;
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevAgyEnv === undefined) delete process.env.FARMSLOT_AGY_EXECUTABLE;
    else process.env.FARMSLOT_AGY_EXECUTABLE = prevAgyEnv;
    rmSync(root, { recursive: true, force: true });
  });

  process.env.FARMSLOT_HOME = farmHome;
  delete process.env.FARMSLOT_AGY_EXECUTABLE;
  process.env.PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

  // Use the node's own supported profile-add route instead of a mocked client cast.
  await service.route({
    owner: 'owner',
    method: 'native.profile.add',
    params: {
      profileId: 'work',
      runner: 'antigravity',
      directory: profileDir,
    },
  });

  await service.startObservation(() => {});
  const initialReceipt = service.observationReceipt();
  assert.equal(initialReceipt?.ready, true);

  // Without trusted executables, agy is absent from PATH.
  const withoutExec = (await service.routeObserved({
    owner: 'owner',
    method: 'native.profile.status',
    params: { profileId: 'work' },
  })) as { value: NativeProfileStatusResult };
  assert.equal(withoutExec.value.account.installed, false);

  // Explicit empty-map acknowledgement on a cold node with no overrides shares the canonical
  // empty digest ('[]') and skips redundant account sampling (same revision and observedAt).
  const emptyAckReceipt = await service.configureObservation({
    owner: 'owner',
    executables: {},
  });
  assert.equal(emptyAckReceipt.ready, true);
  assert.equal(emptyAckReceipt.revision, initialReceipt?.revision);
  const afterEmptyAck = (await service.routeObserved({
    owner: 'owner',
    method: 'native.profile.status',
    params: { profileId: 'work' },
  })) as { value: NativeProfileStatusResult };
  assert.equal(afterEmptyAck.value.account.observedAt, withoutExec.value.account.observedAt);

  // Configure trusted executables at the observation owner before admitting reads.
  const configuredReceipt = await service.configureObservation({
    owner: 'owner',
    executables: { antigravity: fakeAgyV1 },
  });
  assert.equal(configuredReceipt.ready, true);

  const withExec = (await service.routeObserved({
    owner: 'owner',
    method: 'native.profile.status',
    params: { profileId: 'work' },
  })) as { value: NativeProfileStatusResult };
  assert.equal(withExec.value.account.installed, true);
  assert.equal(withExec.value.account.login, 'authenticated');
  assert.equal(withExec.value.account.version, '1.5.12');
  assert.ok(withExec.value.loginCommand.includes(fakeAgyV1));
  const probesAfterFirst = readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(probesAfterFirst, 1);

  // Repeated observed reads with unchanged config are pure cache hits with zero extra probes.
  const cached = (await service.routeObserved({
    owner: 'owner',
    method: 'native.profile.status',
    params: { profileId: 'work' },
  })) as { value: NativeProfileStatusResult };
  assert.equal(cached.value.account.version, '1.5.12');
  assert.equal(
    readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length,
    probesAfterFirst,
  );

  // Concurrent reconfigurations coalesce onto one refresh and serve the updated binary.
  await Promise.all([
    service.configureObservation({ owner: 'owner', executables: { antigravity: fakeAgyV2 } }),
    service.configureObservation({ owner: 'owner', executables: { antigravity: fakeAgyV2 } }),
  ]);
  const updated = (await service.routeObserved({
    owner: 'owner',
    method: 'native.profile.status',
    params: { profileId: 'work' },
  })) as { value: NativeProfileStatusResult };
  assert.equal(updated.value.account.version, '1.5.13');
  assert.ok(updated.value.loginCommand.includes(fakeAgyV2));
  assert.equal(
    readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length,
    probesAfterFirst + 1,
  );

  // Reconnecting preserves the node's last digest until the gateway explicitly configures {} (removed override).
  await service.startObservation(() => {});
  const clearedReceipt = await service.configureObservation({
    owner: 'owner',
    executables: {},
  });
  assert.equal(clearedReceipt.ready, true);
  const afterClear = (await service.routeObserved({
    owner: 'owner',
    method: 'native.profile.status',
    params: { profileId: 'work' },
  })) as { value: NativeProfileStatusResult };
  assert.equal(afterClear.value.account.installed, false);

  // The registration map is applied before the newly armed observation samples the profile.
  await service.startObservation(() => {}, { antigravity: fakeAgyV1 });
  assert.equal(service.observationReceipt()?.ready, true);
  const afterRegistration = (await service.routeObserved({
    owner: 'owner',
    method: 'native.profile.status',
    params: { profileId: 'work' },
  })) as { value: NativeProfileStatusResult };
  assert.equal(afterRegistration.value.account.version, '1.5.12');
  assert.equal(afterRegistration.value.account.executable, realpathSync(fakeAgyV1));
});

test('Cursor account observation resolves login PATH and probes from the host root', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-cursor-account-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cursor = path.join(root, 'cursor-agent');
  writeFileSync(
    cursor,
    `#!${process.execPath}
if (process.cwd() !== '/' || process.env.PROOF_LOGIN !== 'present') process.exit(2);
if (process.argv[2] === '--version') console.log('1.2.3');
else if (process.argv.slice(2).join(' ') === 'status --format json')
  console.log(JSON.stringify({ isAuthenticated: true, userInfo: { email: 'cursor@example.invalid' } }));
else process.exit(2);
`,
    { mode: 0o700 },
  );
  const result = await observeNodeNativeAccount({ runner: 'cursor' }, async () => ({
    PATH: root,
    PROOF_LOGIN: 'present',
  }));
  assert.equal(result.login, 'authenticated');
  assert.equal(result.executable, realpathSync(cursor));
  assert.equal(result.identity?.email, 'cursor@example.invalid');
});
