import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { WebSocket } from 'ws';

import { Methods, type Principal } from '@farmslot/protocol';

import { registerNode, unregisterByWs } from '../fleet/machine-registry.js';
import { handleNodeResponse } from '../fleet/node-rpc.js';
import { nativeSessionRoute } from '../methods/native-session.js';
import { listNativeExecutions, routeNativeExecution } from '../runners/native/node.js';
import type { ClientState } from '../server/client-state.js';

import { createGatewayAuthRuntime, initializeGatewayIdentity } from './auth.js';
import {
  authorizeGatewayHttp,
  authorizeGatewayMethod,
  canReceiveBroadcast,
  gatewayWorkspaceAccess,
} from './authorization.js';
import { hasNativeWorkspaceAccess, nativeOwnerCanUseWorkers } from './native-owner.js';
import { runWithSessionOriginator } from './work-originator.js';

test('worker authority follows resolved solo mode and its activation latch', () => {
  const home = mkdtempSync(join(tmpdir(), 'native-solo-authority-'));
  try {
    const runtime = createGatewayAuthRuntime({
      FARMSLOT_HOME: home,
      FARMSLOT_GATEWAY_AUTH_MODE: 'none',
    });
    initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
    const solo = { authenticated: true, clientKind: 'ui' as const };
    const principal = authorizeGatewayMethod(runtime, solo, Methods.NATIVE_SESSION_READ);
    assert.equal(principal.id, 'local-admin');
    assert.equal(gatewayWorkspaceAccess(principal, runtime.store.snapshot().principals), 'farm');
    assert.equal(nativeOwnerCanUseWorkers(principal), true);
    const owner = runtime.writer.createPrincipal({ type: 'person', displayName: 'Owner' }, []);
    runtime.writer.issueCredential(owner.id, 'owner');
    assert.throws(
      () => authorizeGatewayMethod(runtime, solo, Methods.NATIVE_SESSION_READ),
      /requires authentication/,
    );
    assert.equal(runtime.resolver.resolvePrincipalId('local-admin').ok, false);
    assert.equal(nativeOwnerCanUseWorkers(owner), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('role-free enrollment grants only native ingress, never farm HTTP or broadcasts', () => {
  const home = mkdtempSync(join(tmpdir(), 'native-owner-ingress-'));
  try {
    const runtime = createGatewayAuthRuntime({
      FARMSLOT_HOME: home,
      FARMSLOT_GATEWAY_AUTH_MODE: 'none',
    });
    initializeGatewayIdentity(runtime, { host: '127.0.0.1' });
    const owner = runtime.writer.createPrincipal(
      { type: 'person', displayName: 'Native owner' },
      [],
    );
    const issue = runtime.writer.issueCredential(owner.id, 'native-client');
    assert.equal(gatewayWorkspaceAccess(owner, runtime.store.snapshot().principals), 'none');
    const state = {
      authenticated: true,
      clientKind: 'ui' as const,
      authentication: { kind: 'credential' as const, credentialId: issue.record.id },
    };
    assert.throws(
      () => authorizeGatewayMethod(runtime, state, Methods.NATIVE_SESSION_LIST),
      /Denied/,
    );
    runtime.writer.createPrincipal(
      {
        type: 'node',
        displayName: 'Own node',
        machine: 'native-owner-a',
        nativeOwnerPrincipalId: owner.id,
      },
      [],
    );
    assert.equal(gatewayWorkspaceAccess(owner, runtime.store.snapshot().principals), 'native');
    for (const method of [
      Methods.GATEWAY_PING,
      Methods.NATIVE_SESSION_CATALOG,
      Methods.NATIVE_SESSION_LIST,
      Methods.NATIVE_SESSION_CREATE,
      Methods.NATIVE_SESSION_ENSURE,
      Methods.NATIVE_SESSION_READ,
      Methods.NATIVE_SESSION_SEND,
      Methods.NATIVE_SESSION_RESPOND,
      Methods.NATIVE_SESSION_INTERRUPT,
      Methods.NATIVE_SESSION_CLOSE,
      Methods.NATIVE_SESSION_WORKSPACE_LIST,
      Methods.NATIVE_SESSION_WORKSPACE_READ,
      Methods.NATIVE_SESSION_WORKSPACE_CHANGES,
      Methods.NATIVE_SESSION_WORKSPACE_DIFF,
    ])
      assert.equal(authorizeGatewayMethod(runtime, state, method).id, owner.id);
    for (const method of [
      Methods.FLEET_STATUS,
      Methods.RUN_LIST,
      Methods.RUN_GET,
      Methods.TERMINAL_SUBSCRIBE,
      Methods.PRINCIPAL_LIST,
      Methods.CREDENTIAL_ISSUE,
      Methods.GATEWAY_STATUS,
      'unknown.native.method',
    ])
      assert.throws(() => authorizeGatewayMethod(runtime, state, method), /Denied/);
    for (const resource of ['file', 'run-artifact'] as const)
      assert.throws(() => authorizeGatewayHttp(runtime, state, resource), /Denied/);
    for (const event of [
      'hello',
      'fleet.updated',
      'run.updated',
      'node.connected',
      'file.transfer.progress',
      'native.session.updated',
    ])
      assert.equal(canReceiveBroadcast(runtime, state as ClientState, event), false);
    runtime.writer.revokeCredential(issue.record.id);
    assert.throws(
      () => authorizeGatewayMethod(runtime, state, Methods.NATIVE_SESSION_LIST),
      /requires authentication/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('remote owner routing excludes local host and rejects other owners before node requests', async () => {
  const owner: Principal = {
    id: 'native-owner-ingress-a',
    subject: { type: 'person', displayName: 'A' },
    roles: [],
  };
  let calls = 0;
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      calls++;
      const request = JSON.parse(raw);
      queueMicrotask(() =>
        handleNodeResponse(request.id, true, { sessions: [] }, undefined, undefined, ws),
      );
    },
  } as WebSocket;
  registerNode(
    'native-owner-ingress-node',
    1,
    ws,
    undefined,
    undefined,
    { ownerPrincipalId: owner.id },
    { principalId: 'node-a', valid: () => true },
  );
  try {
    await assert.rejects(
      routeNativeExecution('other', Methods.NATIVE_SESSION_LIST, {
        executionNodeId: 'native-owner-ingress-node',
      }),
      /unavailable for this owner/,
    );
    await assert.rejects(
      routeNativeExecution(owner.id, Methods.NATIVE_SESSION_LIST, {}),
      /local execution is unavailable/,
    );
    assert.equal(calls, 0);
    const inventory = await listNativeExecutions(owner.id);
    assert.deepEqual(inventory.sessions, []);
    assert.equal(
      inventory.unavailableExecutionNodes?.some((node) => node.executionNodeId === 'local'),
      false,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      runWithSessionOriginator(owner, () =>
        nativeSessionRoute(
          Methods.NATIVE_SESSION_READ,
          {
            sessionId: 'worker',
            executionNodeId: 'native-owner-ingress-node',
            worker: { runId: 'foreign' },
          },
          owner,
        ),
      ),
      /does not grant worker controls/,
    );
    assert.equal(calls, 1);
  } finally {
    unregisterByWs(ws);
  }
});

test('node subject cannot acquire user ingress from another assigned node', () => {
  const node: Principal = {
    id: 'node-a',
    subject: { type: 'node', displayName: 'Node', machine: 'a', nativeOwnerPrincipalId: 'node-a' },
    roles: [],
  };
  assert.equal(hasNativeWorkspaceAccess(node, [node]), false);
});

test('role-free users cannot operate a worker by omitting the worker selector', async () => {
  const owner: Principal = {
    id: 'native-owner-ingress-worker',
    subject: { type: 'person', displayName: 'Owner' },
    roles: [],
  };
  const machine = 'native-owner-ingress-worker-node';
  const calls: string[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const request = JSON.parse(raw);
      calls.push(request.params.method);
      queueMicrotask(() =>
        handleNodeResponse(
          request.id,
          true,
          {
            session: {
              id: 'worker',
              ownerPrincipalId: owner.id,
              executionNodeId: machine,
              workerManaged: true,
            },
          },
          undefined,
          undefined,
          ws,
        ),
      );
    },
  } as WebSocket;
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    { ownerPrincipalId: owner.id },
    { principalId: 'node', valid: () => true },
  );
  try {
    for (const method of [
      Methods.NATIVE_SESSION_READ,
      Methods.NATIVE_SESSION_SEND,
      Methods.NATIVE_SESSION_RESPOND,
      Methods.NATIVE_SESSION_INTERRUPT,
      Methods.NATIVE_SESSION_CLOSE,
      Methods.NATIVE_SESSION_WORKSPACE_READ,
    ]) {
      await assert.rejects(
        runWithSessionOriginator(owner, () =>
          nativeSessionRoute(method, { sessionId: 'worker', executionNodeId: machine }, owner),
        ),
        /does not grant worker access/,
      );
    }
    assert.ok(
      calls.length === 6 && calls.every((method) => method === Methods.NATIVE_SESSION_READ),
    );
  } finally {
    unregisterByWs(ws);
  }
});
