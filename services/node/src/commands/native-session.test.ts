import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NativeNodeSessions } from './native-session.js';

test('node native execution rejects other owners and conflicting execution identities before startup', async () => {
  const service = new NativeNodeSessions('node-a', 'owner', '/unused-native-test');
  assert.deepEqual(service.declaration, {
    ownerPrincipalId: 'owner',
    supportsStandaloneDelegation: true,
    supportsEnsure: true,
    supportsWorkers: true,
    supportsProfiles: true,
    supportsWorkerStopAttestation: true,
    supportsStructuredResults: true,
    supportsObservations: true,
  });
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
  assert.equal(JSON.stringify(old).includes(secret), false);
  writeFileSync(
    path.join(hostRoot, 'host.json'),
    JSON.stringify({
      executionNodeId: 'fixture-machine',
      pid: process.pid,
      socket,
      token: secret,
      supportsStandaloneDelegation: true,
    }),
    { mode: 0o600 },
  );
  assert.equal(service.metadata('owner').supportsStandaloneDelegation, true);
});
