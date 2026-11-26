import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

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
