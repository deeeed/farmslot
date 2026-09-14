import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import { NATIVE_WORKER_CANCEL } from '@farmslot/agent-runtime/native';
import { Methods } from '@farmslot/protocol';

import {
  getAllNodes,
  getNode,
  registerNode,
  unregisterByWs,
} from '../../fleet/machine-registry.js';
import { handleNodeResponse } from '../../fleet/node-rpc.js';

import { routeNativeExecution } from './node.js';

test('native requests recheck issued authority after a reply and refuse revoked dispatch', async () => {
  const machine = 'native-authority-test';
  const owner = 'owner';
  let active = true;
  let requestId = '';
  let requests = 0;
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      requests++;
      requestId = JSON.parse(raw).id;
    },
  } as WebSocket;
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    { ownerPrincipalId: owner },
    { principalId: 'node', valid: () => active },
  );
  try {
    const pending = routeNativeExecution(owner, Methods.NATIVE_SESSION_LIST, {
      executionNodeId: machine,
    });
    active = false;
    handleNodeResponse(requestId, true, { sessions: [] }, undefined, undefined, ws);
    await assert.rejects(pending, /authority changed/);
    await assert.rejects(
      routeNativeExecution(owner, Methods.NATIVE_SESSION_LIST, { executionNodeId: machine }),
      /unavailable for this owner/,
    );
    assert.equal(requests, 1);
    assert.equal(
      'nativeAuthority' in getAllNodes().find((node) => node.machine === machine)!,
      false,
    );
  } finally {
    unregisterByWs(ws);
  }
});

test('remote cancellation accepts an explicitly fenced generation race and rejects mismatched replies', async () => {
  const machine = 'native-cancel-broker-test';
  const owner = 'native-owner';
  const valid = {
    cancelled: false,
    reason: 'generation-changed',
    sessionId: 'session',
    leaseId: 'lease',
    generation: 'next',
  };
  let payload: unknown = valid;
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const frame = JSON.parse(raw);
      handleNodeResponse(frame.id, true, payload, undefined, undefined, ws);
    },
  } as WebSocket;
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    {
      ownerPrincipalId: owner,
      supportsWorkers: true,
    },
    { principalId: 'node-test', valid: () => true },
  );
  const params = {
    executionNodeId: machine,
    sessionId: 'session',
    leaseId: 'lease',
    generation: 'old',
    resumeCommandId: 'recovery',
  };
  try {
    assert.deepEqual(await routeNativeExecution(owner, NATIVE_WORKER_CANCEL, params), valid);
    await assert.rejects(
      routeNativeExecution(owner, NATIVE_WORKER_CANCEL, { ...params, resumeCommandId: undefined }),
      /mismatched worker cancellation/,
    );
    for (const wrong of [
      { ...valid, sessionId: 'other' },
      { ...valid, leaseId: 'other' },
      { ...valid, generation: 'old' },
      { ...valid, generation: '' },
      { ...valid, reason: 'unknown' },
      { ...valid, session: {} },
    ]) {
      payload = wrong;
      await assert.rejects(
        routeNativeExecution(owner, NATIVE_WORKER_CANCEL, params),
        /mismatched worker cancellation/,
      );
    }
  } finally {
    unregisterByWs(ws);
  }
});

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
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    {
      ownerPrincipalId: owner,
      supportsEnsure: true,
    },
    { principalId: 'node-test', valid: () => true },
  );
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
    for (const supportsEnsure of [undefined, false]) {
      registerNode(
        machine,
        1,
        ws,
        undefined,
        undefined,
        {
          ownerPrincipalId: owner,
          supportsEnsure,
        },
        { principalId: 'node-test', valid: () => true },
      );
      const beforeLegacy = requests;
      await assert.rejects(route(Methods.NATIVE_SESSION_ENSURE), /execution node upgrade required/);
      assert.equal(requests, beforeLegacy, 'Old nodes must not receive a reserved create');
      payload = { sessions: [session] };
      assert.deepEqual(await route(Methods.NATIVE_SESSION_LIST), payload);
    }
  } finally {
    unregisterByWs(ws);
  }
});
