import type { Principal } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import { nativeOwnerAssignedMachines } from './native-node.js';
import { currentSessionOriginator } from './work-originator.js';

export function ownsLocalNativeProfile(owner: string): boolean {
  return Boolean(owner && process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID === owner);
}

/** Enrollment allows entering native RPCs; each requested execution target is checked separately. */
export function hasNativeWorkspaceAccess(
  principal: Principal,
  principals: readonly Principal[],
): boolean {
  return (
    principal.subject.type !== 'node' &&
    (ownsLocalNativeProfile(principal.id) ||
      nativeOwnerAssignedMachines(principals, principal.id).size > 0)
  );
}

export function requireNativeSessionOwner(): string {
  const originator = currentSessionOriginator();
  if (originator.kind !== 'principal')
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native workspace requires an authenticated owner',
    );
  return originator.principalId;
}

/** Worker/run APIs still require farm administration; standalone enrollment does not grant it. */
export function nativeOwnerCanUseWorkers(principal: Principal): boolean {
  return Boolean(
    principal.subject.type !== 'node' &&
    principal.roles.some((binding) => binding.role === 'admin' && binding.scope.kind === 'global'),
  );
}
