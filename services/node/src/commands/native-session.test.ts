import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { NativeProfileStatusResult } from '@farmslot/protocol';

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

test('observed remote native.profile.status refreshes with trusted executables outside PATH and serves repeated reads from cache', async (t) => {
  const { routeNativeProfile } = await import('@farmslot/agent-runtime/native/profile-service');
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-observed-agy-'));
  const farmHome = path.join(root, 'farm-home');
  const stateRoot = path.join(root, 'state');
  const nodeDir = path.join(stateRoot, 'nodes', 'remote-agy-node');
  const profileDir = path.join(root, 'work-profile');
  const probeLog = path.join(root, 'probes.log');
  const fakeAgy = path.join(root, 'custom-bin', 'agy');
  mkdirSync(farmHome, { recursive: true });
  mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
  chmodSync(nodeDir, 0o700);
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(path.dirname(fakeAgy), { recursive: true });
  writeFileSync(
    fakeAgy,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  fs.appendFileSync(${JSON.stringify(probeLog)}, 'version\\n');
  console.log('1.5.12');
  process.exit(0);
}
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' } } });
  }
  if (m.method === 'session/list') {
    return send({ id: m.id, result: { sessions: [] } });
  }
});
`,
  );
  chmodSync(fakeAgy, 0o700);

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

  await routeNativeProfile({} as never, 'owner', 'native.profile.add', {
    profileId: 'work',
    runner: 'antigravity',
    directory: profileDir,
  });

  await service.startObservation(() => {});
  assert.equal(service.observationReceipt()?.ready, true);

  // Without trusted executables, agy is absent from PATH.
  const withoutExec = (await service.routeObserved({
    owner: 'owner',
    method: 'native.profile.status',
    params: { profileId: 'work' },
  })) as { value: NativeProfileStatusResult };
  assert.equal(withoutExec.value.account.installed, false);

  // When gateway supplies trusted executables on observed profile status, the node updates its
  // retained observation producer and returns authenticated status using the configured binary.
  const withExec = (await service.routeObserved({
    owner: 'owner',
    method: 'native.profile.status',
    params: { profileId: 'work' },
    executables: { antigravity: fakeAgy },
  })) as { value: NativeProfileStatusResult };
  assert.equal(withExec.value.account.installed, true);
  assert.equal(withExec.value.account.login, 'authenticated');
  assert.ok(withExec.value.loginCommand.includes(fakeAgy));
  const probesAfterFirst = readFileSync(probeLog, 'utf8').trim().split('\n').filter(Boolean).length;
  assert.equal(probesAfterFirst, 1);

  // A repeated observed read with unchanged executables is served from the retained cache without re-probing.
  const cached = (await service.routeObserved({
    owner: 'owner',
    method: 'native.profile.status',
    params: { profileId: 'work' },
    executables: { antigravity: fakeAgy },
  })) as { value: NativeProfileStatusResult };
  assert.equal(cached.value.account.login, 'authenticated');
  const probesAfterSecond = readFileSync(probeLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean).length;
  assert.equal(probesAfterSecond, probesAfterFirst);
});
