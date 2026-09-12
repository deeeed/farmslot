import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import { Methods } from '@farmslot/protocol';

import {
  getAllNodes,
  getNode,
  registerNode,
  unregisterByWs,
} from '../../fleet/machine-registry.js';
import { handleNodeResponse } from '../../fleet/node-rpc.js';

import { routeNativeExecution } from './node.js';

test('remote native routing validates reply shape and exact owner, node, and session identity', async () => {
  const machine = 'native-broker-test';
  const owner = 'native-owner-test';
  const session = { id: 'session-a', ownerPrincipalId: owner, executionNodeId: machine };
  let payload: unknown;
  let requests = 0;
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const frame = JSON.parse(raw);
      requests++;
      assert.equal(frame.method, 'native.session');
      assert.equal(frame.params.owner, owner);
      handleNodeResponse(frame.id, true, payload, undefined, undefined, ws);
    },
  } as WebSocket;
  registerNode(machine, 1, ws, undefined, undefined, { ownerPrincipalId: owner });
  const publicNode = getAllNodes().find((node) => node.machine === machine)!;
  assert.equal('nativeSessions' in publicNode, false);
  assert.equal(getNode(machine)?.nativeSessions?.ownerPrincipalId, owner);
  const route = (method: string) =>
    routeNativeExecution(owner, method, {
      executionNodeId: machine,
      sessionId: session.id,
      runner: 'codex',
      cwd: '/tmp',
    });
  try {
    for (const method of [
      Methods.NATIVE_SESSION_CREATE,
      Methods.NATIVE_SESSION_ENSURE,
      Methods.NATIVE_SESSION_READ,
      Methods.NATIVE_SESSION_CLOSE,
    ]) {
      for (const invalid of [
        null,
        [],
        {},
        { sessions: [] },
        { sessions: [session] },
        { session: { ...session, id: '' } },
        { session: { ...session, id: ' ' } },
        { session: { ...session, ownerPrincipalId: 'other-owner' } },
        { session: { ...session, executionNodeId: 'other-node' } },
      ]) {
        payload = invalid;
        await assert.rejects(route(method), /Native node/);
      }
      payload = { session };
      assert.deepEqual(await route(method), payload);
    }
    for (const method of [
      Methods.NATIVE_SESSION_ENSURE,
      Methods.NATIVE_SESSION_READ,
      Methods.NATIVE_SESSION_CLOSE,
    ]) {
      payload = { session: { ...session, id: 'another-session' } };
      await assert.rejects(route(method), /mismatched session/);
    }
    for (const invalid of [{ session }, { sessions: {} }, { sessions: [{ ...session, id: '' }] }]) {
      payload = invalid;
      await assert.rejects(route(Methods.NATIVE_SESSION_LIST), /Native node/);
    }
    for (const sessions of [[], [session]]) {
      payload = { sessions };
      assert.deepEqual(await route(Methods.NATIVE_SESSION_LIST), payload);
    }
    const before = requests;
    await assert.rejects(
      routeNativeExecution('other-owner', Methods.NATIVE_SESSION_LIST, {
        executionNodeId: machine,
      }),
      /unavailable/,
    );
    await assert.rejects(
      routeNativeExecution(owner, Methods.NATIVE_SESSION_LIST, { executionNodeId: 'missing-node' }),
      /unavailable/,
    );
    assert.equal(
      requests,
      before,
      'unauthorized or unavailable targets must never receive a request',
    );
  } finally {
    unregisterByWs(ws);
  }
});
