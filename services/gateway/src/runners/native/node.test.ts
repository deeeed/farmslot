import assert from 'node:assert/strict';
import test from 'node:test';

import { WebSocket } from 'ws';

import {
  NATIVE_WORKER_CANCEL,
  NATIVE_WORKER_COMPACT,
  NATIVE_WORKER_TRANSFER,
} from '@farmslot/agent-runtime/native';
import { NATIVE_NODE_ADMISSION_TIMEOUT_MS } from '@farmslot/agent-runtime/native/host-runtime';
import { Methods } from '@farmslot/protocol';

import {
  getAllNodes,
  getNode,
  registerNode,
  unregisterByWs,
} from '../../fleet/machine-registry.js';
import { handleNodeResponse, withNodeReconnectWait } from '../../fleet/node-rpc.js';
import { createRun, deleteRun, updateRun } from '../../runs/store.js';

import { nativeNodeSessionTimeout, routeNativeExecution } from './node.js';

test('native requests recheck issued authority after a reply and refuse revoked dispatch', async () => {
  const machine = 'native-authority-test';
  const owner = 'owner';
  let active = true;
  let requestId = '';
  let requests = 0;
  let markSent!: () => void;
  const sent = new Promise<void>((resolve) => (markSent = resolve));
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      requests++;
      requestId = JSON.parse(raw).id;
      markSent();
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
    await sent;
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

test('older node decoders cannot silently drop an explicit approval mode before host admission', async () => {
  const machine = 'native-old-approval-decoder';
  const owner = 'native-owner';
  let requests = 0;
  const session = { id: 'session', ownerPrincipalId: owner, executionNodeId: machine };
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      requests++;
      const frame = JSON.parse(raw);
      assert.equal(frame.params.params.approvalMode, 'bypass');
      handleNodeResponse(frame.id, true, { session }, undefined, undefined, ws);
    },
  } as WebSocket;
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    { ownerPrincipalId: owner, supportsEnsure: true },
    { principalId: 'node-test', valid: () => true },
  );
  const params = {
    executionNodeId: machine,
    sessionId: 'session',
    runner: 'codex',
    cwd: '/tmp',
    approvalMode: 'bypass',
  };
  try {
    for (const method of [
      Methods.NATIVE_SESSION_CREATE,
      Methods.NATIVE_SESSION_ENSURE,
      Methods.NATIVE_SESSION_SET_APPROVAL_MODE,
    ])
      await assert.rejects(
        routeNativeExecution(owner, method, params),
        /Execution node upgrade required for per-session approval modes/,
      );
    assert.equal(requests, 0);
    getNode(machine)!.nativeSessions!.supportsApprovalMode = true;
    assert.deepEqual(await routeNativeExecution(owner, Methods.NATIVE_SESSION_CREATE, params), {
      session,
    });
    assert.equal(requests, 1);
  } finally {
    unregisterByWs(ws);
  }
});

/** A node that declares host refresh and refuses the next `refuse` requests as skewed. */
function skewRefusingNode(machine: string, owner: string, supportsHostRefresh: boolean) {
  const frames: Array<{ method: string; hostRelease?: unknown }> = [];
  const state = { refuse: 0, onSend: () => {} };
  const session = { id: 'session', ownerPrincipalId: owner, executionNodeId: machine };
  const ws = {
    readyState: WebSocket.OPEN,
    send(raw: string) {
      const frame = JSON.parse(raw);
      frames.push({ method: frame.params.method, hostRelease: frame.params.hostRelease });
      state.onSend();
      if (state.refuse > 0) {
        state.refuse -= 1;
        handleNodeResponse(
          frame.id,
          false,
          undefined,
          'Native host runtime version skew',
          'NATIVE_HOST_VERSION_SKEW',
          ws,
        );
      } else handleNodeResponse(frame.id, true, { session }, undefined, undefined, ws);
    },
  } as WebSocket;
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    { ownerPrincipalId: owner, supportsEnsure: true, supportsWorkers: true, supportsHostRefresh },
    { principalId: 'node-test', valid: () => true },
  );
  return { frames, state, ws };
}

const skewed = { code: 'NATIVE_HOST_VERSION_SKEW' };

test('a launch a node refuses as skewed is sent once more with the gateway’s release list', async () => {
  const machine = 'native-host-refresh-node';
  const owner = 'native-owner';
  const { frames, state, ws } = skewRefusingNode(machine, owner, false);
  const run = createRun({ flowType: 'dev', project: 'host-refresh', ticketOrPr: 'HOST-REFRESH-1' });
  updateRun(run.id, {
    status: 'done',
    agentContexts: [
      {
        id: 'review-context',
        role: 'review',
        label: 'review',
        status: 'idle',
        slotId: 'slot',
        runId: run.id,
        nativeSession: {
          sessionId: 'finished-reviewer',
          executionNodeId: machine,
          ownerPrincipalId: owner,
          leaseId: 'lease',
          commandId: 'command',
        },
      },
    ],
  });
  const create = { executionNodeId: machine, runner: 'codex', cwd: '/tmp' };
  try {
    // A current host: one send, no list.
    await routeNativeExecution(owner, Methods.NATIVE_SESSION_CREATE, create);
    // An older node gets no list, so its refusal stands.
    state.refuse = 1;
    await assert.rejects(routeNativeExecution(owner, Methods.NATIVE_SESSION_CREATE, create), skewed);
    getNode(machine)!.nativeSessions!.supportsHostRefresh = true;
    // A node that reads one gets it on the second send; a refusal then stands.
    state.refuse = 1;
    await routeNativeExecution(owner, Methods.NATIVE_SESSION_CREATE, create);
    state.refuse = 2;
    await assert.rejects(
      routeNativeExecution(owner, Methods.NATIVE_SESSION_ENSURE, {
        ...create,
        sessionId: 'finished-reviewer',
      }),
      skewed,
    );
    state.refuse = 2;
    await assert.rejects(
      routeNativeExecution(owner, NATIVE_WORKER_TRANSFER, {
        executionNodeId: machine,
        sessionId: 'finished-reviewer',
        leaseId: 'lease',
        generation: 'generation',
      }),
      skewed,
    );
    // A message is not a launch: its refusal is not sent again.
    state.refuse = 1;
    await assert.rejects(
      routeNativeExecution(owner, Methods.NATIVE_SESSION_SEND, {
        executionNodeId: machine,
        sessionId: 'session',
        commandId: 'command',
        text: 'hello',
      }),
      skewed,
    );
    assert.deepEqual(frames, [
      { method: Methods.NATIVE_SESSION_CREATE, hostRelease: undefined },
      { method: Methods.NATIVE_SESSION_CREATE, hostRelease: undefined },
      { method: Methods.NATIVE_SESSION_CREATE, hostRelease: undefined },
      { method: Methods.NATIVE_SESSION_CREATE, hostRelease: ['finished-reviewer'] },
      { method: Methods.NATIVE_SESSION_ENSURE, hostRelease: undefined },
      { method: Methods.NATIVE_SESSION_ENSURE, hostRelease: [] },
      { method: NATIVE_WORKER_TRANSFER, hostRelease: undefined },
      { method: NATIVE_WORKER_TRANSFER, hostRelease: ['finished-reviewer'] },
      { method: Methods.NATIVE_SESSION_SEND, hostRelease: undefined },
    ]);
  } finally {
    unregisterByWs(ws);
    await deleteRun(run.id);
  }
});

test('a launch whose run stopped while the first send waited is not sent again', async () => {
  const machine = 'native-host-refresh-cancel';
  const owner = 'native-owner';
  const { frames, state, ws } = skewRefusingNode(machine, owner, true);
  let cancelled = false;
  state.refuse = 1;
  state.onSend = () => (cancelled = true);
  try {
    await assert.rejects(
      withNodeReconnectWait(
        () =>
          routeNativeExecution(owner, Methods.NATIVE_SESSION_CREATE, {
            executionNodeId: machine,
            runner: 'codex',
            cwd: '/tmp',
          }),
        () => {
          if (cancelled) throw new Error('run was cancelled');
        },
      ),
      /run was cancelled/,
    );
    assert.equal(frames.length, 1);
  } finally {
    unregisterByWs(ws);
  }
});

test('launches and messages to a node that refreshes its host wait long enough for the refresh', () => {
  for (const method of [Methods.NATIVE_SESSION_CREATE, NATIVE_WORKER_TRANSFER, Methods.NATIVE_SESSION_SEND])
    assert.equal(nativeNodeSessionTimeout(method, true), NATIVE_NODE_ADMISSION_TIMEOUT_MS);
  assert.equal(nativeNodeSessionTimeout(Methods.NATIVE_SESSION_CREATE, false), 60_000);
  assert.equal(nativeNodeSessionTimeout(Methods.NATIVE_SESSION_READ, true), 60_000);
  assert.equal(nativeNodeSessionTimeout(NATIVE_WORKER_COMPACT, true), 185_000);
});
