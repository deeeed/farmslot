import assert from 'node:assert/strict';
import test from 'node:test';

import type { NativeExecutionNodeDeclaration, Principal } from '@farmslot/protocol';

import {
  assertNativeMachineAssignment,
  nativeNodeDeclaration,
  nativeOwnerAssignedMachines,
} from './native-node.js';

const principal: Principal = {
  id: 'node-a-principal',
  subject: {
    type: 'node',
    displayName: 'Node A',
    machine: 'node-a',
    nativeOwnerPrincipalId: 'owner',
  },
  roles: [],
};

test('native node declarations require an issued credential for that exact machine', () => {
  const declaration = { ownerPrincipalId: 'owner', supportsInitialObservationConfiguration: true };
  assert.deepEqual([...nativeOwnerAssignedMachines([principal], 'owner')], ['node-a']);
  assert.deepEqual([...nativeOwnerAssignedMachines([principal], 'another-owner')], []);
  assert.deepEqual(
    [
      ...nativeOwnerAssignedMachines(
        [{ ...principal, subject: { type: 'node', displayName: 'legacy', machine: 'legacy' } }],
        'owner',
      ),
    ],
    [],
  );
  assert.throws(
    () => nativeNodeDeclaration({ ownerPrincipalId: 'victim' }, 'node-a', principal, true),
    /server-issued assignment/,
  );
  assert.throws(
    () =>
      nativeNodeDeclaration(
        declaration,
        'node-a',
        { ...principal, subject: { type: 'node', displayName: 'unbound', machine: 'node-a' } },
        true,
      ),
    /server-issued assignment/,
  );
  assert.doesNotThrow(() => assertNativeMachineAssignment('node-a', principal, [principal]));
  assert.throws(
    () => assertNativeMachineAssignment('node-a', { ...principal, id: 'other' }, [principal]),
    /another issued node/,
  );
  assert.throws(
    () => assertNativeMachineAssignment('node-a', undefined, [principal]),
    /another issued node/,
  );
  assert.deepEqual(nativeNodeDeclaration(declaration, 'node-a', principal, true), declaration);
  assert.throws(
    () => nativeNodeDeclaration(declaration, 'node-b', principal, true),
    /issued machine credential/,
  );
  assert.equal(nativeNodeDeclaration(declaration, 'node-a', principal, false), undefined);
  assert.throws(() => nativeNodeDeclaration({}, 'node-a', principal, true), /configured owner/);
  assert.equal(nativeNodeDeclaration(undefined, 'legacy', undefined, false), undefined);
  for (const supportsEnsure of [true, false])
    assert.deepEqual(
      nativeNodeDeclaration({ ...declaration, supportsEnsure }, 'node-a', principal, true),
      { ...declaration, supportsEnsure },
    );
  for (const supportsEnsure of ['true', 1, null])
    assert.throws(
      () => nativeNodeDeclaration({ ...declaration, supportsEnsure }, 'node-a', principal, true),
      /supportsEnsure must be boolean/,
    );
});

test('native node declarations keep every declared boolean capability', () => {
  const capabilities = {
    supportsStandaloneDelegation: true,
    supportsApprovalMode: true,
    supportsEnsure: true,
    supportsWorkers: true,
    supportsWorkerStopAttestation: true,
    supportsProfiles: true,
    supportsObservations: true,
    supportsObservationConfiguration: true,
    supportsInitialObservationConfiguration: true,
    supportsStructuredResults: true,
    supportsHostRefresh: true,
    supportsSessionArchive: true,
  } satisfies Required<
    Omit<NativeExecutionNodeDeclaration, 'ownerPrincipalId' | 'conversationStreaming'>
  >;
  const declaration = {
    ownerPrincipalId: 'owner',
    conversationStreaming: 1,
    ...capabilities,
  } as const;
  assert.deepEqual(nativeNodeDeclaration(declaration, 'node-a', principal, true), declaration);
  for (const field of Object.keys(capabilities))
    assert.throws(
      () => nativeNodeDeclaration({ ...declaration, [field]: 'true' }, 'node-a', principal, true),
      new RegExp(`${field} must be boolean`),
    );
});
