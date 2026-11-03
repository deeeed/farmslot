import type { Principal } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { resolveNativeExecutionNode } from '../runners/native/node.js';

import { loadCredentialStore } from './credential-store.js';
import { requireGenerationZeroOwner } from './native-node.js';

/** Standalone supervision is an explicit person-admin capability, never node ownership. */
export function isStandaloneAdmin(principal: Principal): boolean {
  return (
    principal.subject.type === 'person' &&
    principal.roles.some((binding) => binding.role === 'admin' && binding.scope.kind === 'global')
  );
}

export function assertStandaloneAdmin(principal: Principal): void {
  const current = loadCredentialStore().principals.find((p) => p.id === principal.id);
  if (
    !current ||
    (current.generation ?? 0) !== (principal.generation ?? 0) ||
    !isStandaloneAdmin(current)
  )
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Standalone admin authority changed');
}

/** Issued targets remain visible while disconnected; routing still needs a current socket. */
export function standaloneOwners(principal: Principal): Map<string, string> {
  assertStandaloneAdmin(principal);
  return new Map(
    loadCredentialStore().principals.flatMap((p) =>
      p.subject.type === 'node' && p.subject.nativeOwnerPrincipalId
        ? [[p.subject.machine, p.subject.nativeOwnerPrincipalId] as const]
        : [],
    ),
  );
}

export function standaloneOwner(principal: Principal, executionNodeId: string): string {
  assertStandaloneAdmin(principal);
  const owner =
    executionNodeId === 'local'
      ? process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID
      : standaloneOwners(principal).get(executionNodeId);
  const configured = loadCredentialStore().principals.find((p) => p.id === owner);
  if (!owner || !configured || configured.subject.type === 'node')
    throw new GatewayMethodError(
      'NATIVE_SOURCE_UNAVAILABLE',
      'Target has no configured native owner',
    );
  requireGenerationZeroOwner(owner);
  if (executionNodeId !== 'local') {
    const node = resolveNativeExecutionNode(owner, executionNodeId);
    if (!node.nativeSessions.supportsStandaloneDelegation)
      throw new GatewayMethodError(
        'NATIVE_SOURCE_UNAVAILABLE',
        'Update the execution node for standalone admin sessions',
      );
  }
  return owner;
}
