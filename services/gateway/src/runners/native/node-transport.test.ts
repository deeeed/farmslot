import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { Methods } from '@farmslot/protocol';

import { registerNode, unregisterByWs } from '../../fleet/machine-registry.js';
import {
  handleNodeResponse,
  isNodeTransportUnavailableError,
  NodeRpcTimeoutError,
} from '../../fleet/node-rpc.js';
import { createGatewayAuthRuntime } from '../../security/auth.js';

import { requestNativeNode, resolveNativeExecutionNode, routeNativeExecution } from './node.js';

function issuedFixture() {
  const priorHome = process.env.FARMSLOT_HOME;
  const home = mkdtempSync(path.join(tmpdir(), 'native-transport-owner-'));
  process.env.FARMSLOT_HOME = home;
  const runtime = createGatewayAuthRuntime({
    FARMSLOT_HOME: home,
    FARMSLOT_GATEWAY_AUTH_MODE: 'none',
  });
  const owner = runtime.writer.createPrincipal(
    { type: 'person', displayName: 'Transport fixture owner' },
    [],
  );
  const machine = 'transport-owned-machine';
  const node = runtime.writer.createPrincipal(
    {
      type: 'node',
      machine,
      displayName: 'Transport fixture node',
      nativeOwnerPrincipalId: owner.id,
    },
    [],
  );
  const credential = runtime.writer.issueCredential(node.id, 'fixture-node');
  return {
    runtime,
    owner,
    node,
    machine,
    credential,
    cleanup() {
      if (priorHome === undefined) delete process.env.FARMSLOT_HOME;
      else process.env.FARMSLOT_HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}
const permanent = (error: unknown) => {
  assert.equal(isNodeTransportUnavailableError(error), false);
  return true;
};

test('filesystem commands reject missing capabilities, revoked owners and foreign replies', async () => {
  const machine = 'owned-filesystem-fixture';
  const foreign = { readyState: WebSocket.OPEN } as WebSocket;
  let sent = 0;
  let active = true;
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      sent++;
      const { id } = JSON.parse(raw);
      handleNodeResponse(id, true, { source: 'foreign' }, undefined, undefined, foreign);
      handleNodeResponse(id, true, { source: 'owned' }, undefined, undefined, ws);
    },
  } as WebSocket;
  const register = (workers: boolean) =>
    registerNode(
      machine,
      1,
      ws,
      undefined,
      undefined,
      { ownerPrincipalId: 'owner', supportsWorkers: workers, supportsEnsure: workers },
      { principalId: 'node', valid: () => active },
    );
  try {
    register(false);
    await assert.rejects(requestNativeNode('owner', machine, 'fs.writeFiles', {}, 100), permanent);
    assert.equal(sent, 0);
    register(true);
    assert.deepEqual(await requestNativeNode('owner', machine, 'exec', {}, 100), {
      source: 'owned',
    });
    active = false;
    await assert.rejects(requestNativeNode('owner', machine, 'fs.writeFiles', {}, 100), permanent);
    assert.equal(sent, 1);
  } finally {
    unregisterByWs(ws);
  }
});

test('offline native nodes are retryable only with a current issued owner and active node credential', () => {
  const f = issuedFixture();
  try {
    assert.throws(
      () => resolveNativeExecutionNode(f.owner.id, f.machine),
      (error: unknown) => {
        assert(isNodeTransportUnavailableError(error));
        assert.equal(error.reason, 'not-connected');
        return true;
      },
    );
    assert.throws(() => resolveNativeExecutionNode('other-owner', f.machine), permanent);
    assert.throws(() => resolveNativeExecutionNode(f.owner.id, 'unknown-machine'), permanent);
    f.runtime.writer.revokeCredential(f.credential.record.id);
    assert.throws(() => resolveNativeExecutionNode(f.owner.id, f.machine), permanent);
  } finally {
    f.cleanup();
  }
});

test('a closed assigned connection is transport loss; absent live authority and revoked ownership never fall back', () => {
  const f = issuedFixture();
  const ws = { readyState: WebSocket.CLOSED } as WebSocket;
  try {
    registerNode(f.machine, 1, ws, undefined, undefined, { ownerPrincipalId: f.owner.id });
    assert.throws(() => resolveNativeExecutionNode(f.owner.id, f.machine), permanent);
    registerNode(
      f.machine,
      1,
      ws,
      undefined,
      undefined,
      { ownerPrincipalId: f.owner.id },
      { principalId: f.node.id, valid: () => false },
    );
    assert.throws(
      () => resolveNativeExecutionNode(f.owner.id, f.machine),
      (error: unknown) => {
        assert(isNodeTransportUnavailableError(error));
        assert.equal(error.reason, 'disconnected');
        return true;
      },
    );
    f.runtime.writer.revokeCredential(f.credential.record.id);
    assert.throws(() => resolveNativeExecutionNode(f.owner.id, f.machine), permanent);
  } finally {
    unregisterByWs(ws);
    f.cleanup();
  }
});

test('a reply from a replaced authorized connection is retryable; owner/principal replacement is terminal', async () => {
  const machine = 'native-replacement-fixture';
  const owner = 'owner';
  for (const replacement of [
    { owner, principal: 'node', transient: true },
    { owner: 'other-owner', principal: 'node', transient: false },
    { owner, principal: 'other-node', transient: false },
  ]) {
    const next = { readyState: WebSocket.OPEN } as WebSocket;
    const previous = {
      readyState: WebSocket.OPEN,
      send(raw: string) {
        registerNode(
          machine,
          2,
          next,
          undefined,
          undefined,
          { ownerPrincipalId: replacement.owner },
          { principalId: replacement.principal, valid: () => true },
        );
        handleNodeResponse(
          JSON.parse(raw).id,
          true,
          { sessions: [] },
          undefined,
          undefined,
          previous,
        );
      },
    } as WebSocket;
    registerNode(
      machine,
      1,
      previous,
      undefined,
      undefined,
      { ownerPrincipalId: owner },
      { principalId: 'node', valid: () => true },
    );
    try {
      await assert.rejects(
        routeNativeExecution(owner, Methods.NATIVE_SESSION_LIST, { executionNodeId: machine }),
        (error: unknown) => {
          assert.equal(isNodeTransportUnavailableError(error), replacement.transient);
          if (isNodeTransportUnavailableError(error))
            assert.equal(error.reason, 'connection-replaced');
          return true;
        },
      );
    } finally {
      unregisterByWs(previous);
      unregisterByWs(next);
    }
  }
});

test('deadline uncertainty is classified only after rechecking live authority', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const machine = 'native-timeout-fixture';
  const ws = { readyState: WebSocket.OPEN, send() {} } as unknown as WebSocket;
  let active = true;
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    { ownerPrincipalId: 'owner' },
    { principalId: 'node', valid: () => active },
  );
  try {
    const timeout = assert.rejects(
      routeNativeExecution('owner', Methods.NATIVE_SESSION_LIST, { executionNodeId: machine }),
      (error: unknown) => {
        assert(error instanceof NodeRpcTimeoutError);
        assert(isNodeTransportUnavailableError(error));
        return true;
      },
    );
    t.mock.timers.tick(60_000);
    await timeout;
    const revoked = assert.rejects(
      routeNativeExecution('owner', Methods.NATIVE_SESSION_LIST, { executionNodeId: machine }),
      permanent,
    );
    active = false;
    t.mock.timers.tick(60_000);
    await revoked;
  } finally {
    unregisterByWs(ws);
    t.mock.timers.reset();
  }
});
