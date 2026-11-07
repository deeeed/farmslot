import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { type NodeRegistrationResult, type PeerVersionDeclaration } from '@farmslot/protocol';

test('a declared incompatible reconnect cannot replace a healthy registration or native owner', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'peer-registration-'));
  for (const name of ['scripts', 'services/gateway', 'pool', 'projects'])
    await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, 'CLAUDE.md'), '# Owned version registration test\n');
  await writeFile(path.join(root, 'scripts/dev.sh'), '#!/bin/sh\n');
  await writeFile(path.join(root, 'services/gateway/package.json'), '{}');
  Object.assign(process.env, {
    FARMSLOT_ROOT: root,
    FARMSLOT_HOME: path.join(root, 'home'),
    FARMSLOT_POOL_DIR: path.join(root, 'pool'),
    FARMSLOT_PROJECTS_DIR: path.join(root, 'projects'),
    FARMSLOT_RUNS_DIR: path.join(root, 'runs'),
    FARMSLOT_NATIVE_STATE_DIR: path.join(root, 'native'),
    FARMSLOT_DISABLE_RUN_ENGINE_START: '1',
    NODE_TEST_CONTEXT: '1',
  });
  await import('../runtime/mock-pty.test-support.js');
  const { createGatewayAuthRuntime } = await import('../security/auth.js');
  const { createWebSocketServer, disposeServerResourceObservations } = await import('../server.js');
  const { getNode, unregisterByWs } = await import('../fleet/machine-registry.js');
  const { authenticateNode, sendGatewayRequest, GatewayRequestError } =
    await import('../../../node/src/gateway-handshake.js');
  const auth = createGatewayAuthRuntime({ FARMSLOT_HOME: path.join(root, 'home') });
  const owner = auth.writer.createPrincipal(
    { type: 'person', displayName: 'Compatibility owner' },
    [{ role: 'admin', scope: { kind: 'global' } }],
  );
  auth.writer.issueCredential(owner.id, 'Fixture bootstrap');
  const machine = 'peer-registration-fixture';
  const principal = auth.writer.createPrincipal(
    { type: 'node', machine, displayName: machine, nativeOwnerPrincipalId: owner.id },
    [],
  );
  const credential = auth.writer.issueCredential(principal.id, 'Fixture machine');
  const server = createServer();
  const wss = createWebSocketServer(server, auth);
  const clients: WebSocket[] = [];
  t.after(async () => {
    for (const socket of wss.clients) {
      unregisterByWs(socket);
      socket.terminate();
    }
    for (const socket of clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    disposeServerResourceObservations();
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    clients.push(socket);
    await once(socket, 'open');
    await authenticateNode(socket, { machine, credential: { token: credential.secret } });
    return socket;
  };
  const versions: PeerVersionDeclaration = {
    protocolVersion: '0.77.0',
    minimumProtocolVersion: '0.76.0',
    runtimeVersion: '0.43.0',
    minimumRuntimeVersion: '0.42.0',
  };
  const original = await connect();
  const reply = await sendGatewayRequest<NodeRegistrationResult>(original, 'node.connect', {
    machine,
    pid: 1,
    ...versions,
    capabilities: [],
    nativeSessions: { ownerPrincipalId: owner.id },
  });
  assert(reply.registered);
  assert.equal(reply.minimumProtocolVersion, '0.76.0');
  const before = getNode(machine);
  assert(before && before.versionMatch);
  const ownerFile = path.join(root, 'native/execution-nodes', machine + '.json');
  const ownerBytes = await readFile(ownerFile, 'utf8');
  const ownerInode = (await stat(ownerFile)).ino;
  const replacement = await connect();
  for (const [declaration, code] of [
    [{ ...versions, minimumProtocolVersion: '9.0.0' }, 'PROTOCOL_INCOMPATIBLE'],
    [{ ...versions, minimumRuntimeVersion: 'invalid' }, 'INVALID_PARAMS'],
    [{ ...versions, minimumProtocolVersion: 42 }, 'INVALID_PARAMS'],
  ] as const) {
    await assert.rejects(
      sendGatewayRequest(replacement, 'node.connect', {
        machine,
        pid: 2,
        ...declaration,
        capabilities: [],
        nativeSessions: { ownerPrincipalId: owner.id },
      }),
      (error) => {
        assert(error instanceof GatewayRequestError);
        assert.equal(error.code, code);
        assert.match(
          error.message,
          code === 'PROTOCOL_INCOMPATIBLE'
            ? /declared minimum 9\.0\.0/
            : /minimum(Protocol|Runtime)Version/,
        );
        return true;
      },
    );
    assert.equal(getNode(machine), before);
    assert.equal(before.ws.readyState, WebSocket.OPEN);
    assert.equal(await readFile(ownerFile, 'utf8'), ownerBytes);
    assert.equal(
      (await stat(ownerFile)).ino,
      ownerInode,
      'Rejected registration must not rewrite native owner state',
    );
  }
});
