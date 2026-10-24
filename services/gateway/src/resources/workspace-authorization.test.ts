import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Principal } from '@farmslot/protocol';
import type { ResourceKey } from '@farmslot/protocol/client-cache';

import { GatewayMethodError } from '../core/method-error.js';
import type { GatewayAuthRuntime } from '../security/auth.js';
import type { ClientState } from '../server/client-state.js';

let principal = { id: 'reader', roles: [], subject: { type: 'person' } } as unknown as Principal;
let authorizationFault: Error | undefined;
let assigned = true;
let remoteReads = 0;
let readOnly = false;
const binding = {
  ownerPrincipalId: 'runner-owner',
  executionNodeId: 'node',
  sessionId: 's',
  generation: 'g',
  leaseId: 'lease',
};
mock.module('../security/authorization.js', {
  namedExports: {
    authorizeGatewayMethod: () => {
      if (authorizationFault) throw authorizationFault;
      return principal;
    },
  },
});
mock.module('../security/credential-store.js', {
  namedExports: { loadCredentialStore: () => ({ principals: [] }) },
});
mock.module('../security/native-node.js', {
  namedExports: {
    nativeOwnerAssignedMachines: () => new Set(assigned ? ['node'] : []),
    requireGenerationZeroOwner: (owner: string) => owner,
  },
});
mock.module('../security/native-owner.js', {
  namedExports: { nativeOwnerCanUseWorkers: () => true, ownsLocalNativeProfile: () => false },
});
mock.module('../security/native-worker-owner.js', {
  namedExports: {
    assertNativeRunOwner: () => {},
    resolveReviewWorkspaceOwner: () => 'runner-owner',
  },
});
mock.module('../security/work-originator.js', {
  namedExports: { runWithSessionOriginator: (_: unknown, read: () => unknown) => read() },
});
mock.module('../runs/store.js', { namedExports: { getRun: () => ({ transport: 'native' }) } });
mock.module('../runners/native/worker-history.js', {
  namedExports: { nativeWorkerHistoryBinding: () => ({ binding, readOnly }) },
});
mock.module('../runners/native/manager.js', {
  namedExports: {
    nativeSessionManager: {
      list: () => {
        remoteReads++;
        throw new Error('producer failed');
      },
    },
  },
});
const { registerWorkspaceReadAlias, canReadWorkspaceResourceKey } =
  await import('./workspace-authorization.js');

test('failure notices need successful exact read alias but never healthy producer; revoke pin/connection/principal locally', async () => {
  const runtime = {} as GatewayAuthRuntime;
  const state = {
    authentication: { kind: 'credential', credentialId: 'credential' },
    clientKind: 'web',
  } as unknown as ClientState;
  const worker = { runId: 'run', contextId: 'context', generation: 'g', leaseId: 'lease' };
  const key: ResourceKey = {
    family: 'workspace',
    ownerId: 'reader',
    nodeId: 'node',
    sessionId: 's',
    contextId: JSON.stringify(worker),
  };
  assert.equal(await canReadWorkspaceResourceKey(runtime, state, key), false);
  registerWorkspaceReadAlias(state, key, {
    ownerId: 'runner-owner',
    nodeId: 'node',
    sessionId: 's',
    cwd: '/owned',
    generation: 'g',
    leaseId: 'lease',
    accountContextId: 'context',
    state: 'open',
  });
  assert.equal(await canReadWorkspaceResourceKey(runtime, state, key), true);
  assert.equal(remoteReads, 0);
  readOnly = true;
  assert.equal(await canReadWorkspaceResourceKey(runtime, state, key), false);
  readOnly = false;
  assigned = false;
  assert.equal(await canReadWorkspaceResourceKey(runtime, state, key), false);
  assigned = true;
  assert.equal(
    await canReadWorkspaceResourceKey(runtime, { ...state }, key),
    false,
    'a new connection cannot inherit aliases',
  );
  principal = { ...principal, id: 'foreign' };
  assert.equal(await canReadWorkspaceResourceKey(runtime, state, key), false);
  principal = { ...principal, id: 'reader' };
  authorizationFault = new GatewayMethodError('AUTH_FORBIDDEN', 'revoked');
  assert.equal(await canReadWorkspaceResourceKey(runtime, state, key), false);
  authorizationFault = new Error('authority store failed');
  await assert.rejects(canReadWorkspaceResourceKey(runtime, state, key), /authority store failed/);
  authorizationFault = undefined;
});
