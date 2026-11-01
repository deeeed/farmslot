import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import { WebSocket } from 'ws';

import type { SlotVars } from '../../core/config.js';

const machine = 'f303-remote';
const owner = 'farm-automation';
const nodePrincipal = 'node-f303-remote';
let credentials: Array<{ principalId: string; revokedAt?: string }> = [];

const credentialStore = await import('../../security/credential-store.js');
mock.module('../../security/credential-store.js', {
  namedExports: {
    ...credentialStore,
    loadCredentialStore: () => ({
      principals: [
        { id: owner, subject: { type: 'person' } },
        {
          id: nodePrincipal,
          subject: { type: 'node', machine, nativeOwnerPrincipalId: owner },
        },
      ],
      credentials,
    }),
  },
});
const nativeNode = await import('../../security/native-node.js');
mock.module('../../security/native-node.js', {
  namedExports: {
    ...nativeNode,
    nativeOwnerAssignedMachines: () => new Set([machine]),
    requireGenerationZeroOwner: (principal: string) => principal,
  },
});
// Owner checks for the review workspace need a session principal; this test is about the node.
const workerOwner = await import('../../security/native-worker-owner.js');
mock.module('../../security/native-worker-owner.js', {
  namedExports: {
    ...workerOwner,
    resolveReviewWorkspaceOwner: (principal: string) => principal,
  },
});

const { registerNode, unregisterByWs } = await import('../../fleet/machine-registry.js');
const { isNodeTransportUnavailableError, resolveAfterNodeReconnect, withNodeReconnectWait } =
  await import('../../fleet/node-rpc.js');
const { makeRun } = await import('../../run-engine/test-fixtures.js');
const { nativeReviewerOwner } = await import('./review-owner.js');

const vars: SlotVars = {
  slotId: 'f303-mm-3',
  machine,
  host: 'f303-remote.example',
  repo: '/fixture',
  remoteRepo: '/fixture',
  projectName: 'f303-proof',
  platform: 'ios',
  sshUser: '',
  osType: 'darwin',
  claudePath: '',
  codexPath: '',
  cursorPath: '',
  grokPath: '',
  opencodePath: '',
  dispatchCmd: '',
  recycleCmd: '',
  session: 'mm-3',
  slotMode: 'dispatch',
  slotEnabled: true,
  sshTarget: '',
  resourceVars: {},
};
const run = makeRun({ id: 'f303-run', slotId: vars.slotId });
const socket = () =>
  ({
    readyState: WebSocket.OPEN,
    send(raw: string) {
      void raw;
    },
  }) as WebSocket;
const registerReviewNode = (ws: WebSocket) =>
  registerNode(
    machine,
    1,
    ws,
    undefined,
    undefined,
    { ownerPrincipalId: owner, supportsWorkers: true, supportsEnsure: true },
    { principalId: nodePrincipal, valid: () => true },
  );
// The review agent's own wiring: reconnect wait scoped to the run still being current.
const reattachOwner = (assertCurrent: () => void = () => {}) =>
  withNodeReconnectWait(
    async () => resolveAfterNodeReconnect(machine, () => nativeReviewerOwner(run, vars)),
    assertCurrent,
  );

test('an offline review node with an issued assignment is a wait, not a missing owner', () => {
  credentials = [{ principalId: nodePrincipal }];
  assert.throws(
    () => nativeReviewerOwner(run, vars),
    (error: unknown) =>
      isNodeTransportUnavailableError(error) && /temporarily unavailable/.test(error.message),
  );
});

test('an offline review node without an issued assignment still has no owner', () => {
  credentials = [{ principalId: nodePrincipal, revokedAt: '2026-11-01T00:00:00.000Z' }];
  assert.throws(
    () => nativeReviewerOwner(run, vars),
    (error: unknown) =>
      !isNodeTransportUnavailableError(error) &&
      error instanceof Error &&
      /no native execution owner/.test(error.message),
  );
});

test('a reload re-entering REVIEW waits for the review node and resolves its owner', async () => {
  credentials = [{ principalId: nodePrincipal }];
  const ws = socket();
  try {
    const pending = reattachOwner();
    setTimeout(() => registerReviewNode(ws), 150);
    assert.equal(await pending, owner);
  } finally {
    unregisterByWs(ws);
  }
});

test('a review superseded while its node reconnects stops waiting', async () => {
  credentials = [{ principalId: nodePrincipal }];
  let current = true;
  setTimeout(() => {
    current = false;
  }, 150);
  await assert.rejects(
    reattachOwner(() => {
      if (!current) throw new Error('Native review was superseded by another run action');
    }),
    /superseded/,
  );
});
