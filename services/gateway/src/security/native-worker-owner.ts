import type { Run } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import { isAdminPrincipal } from './authorization.js';
import { loadCredentialStore } from './credential-store.js';
import { nativeOwnerAssignedMachines } from './native-node.js';
import { currentSessionOriginator, currentSessionPrincipal } from './work-originator.js';

function nativeControlOwner(expectedOwner?: string): string | undefined {
  const originator = currentSessionOriginator();
  if (originator.kind !== 'principal') return expectedOwner;
  return originator.principalId;
}

function isAdminSupervisor(): boolean {
  const principal = currentSessionPrincipal();
  // Supervision authorizes the caller without adopting the runner's identity.
  return principal?.subject.type === 'person' && isAdminPrincipal(principal);
}

export function requireNativeProfileOwner(principalId: string | undefined): string {
  const configured = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  if (!configured || !principalId || principalId !== configured)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native execution requires this principal to own the configured native runner profile',
    );
  return principalId;
}

/** Network requests use their authenticated principal; internal continuations need stored ownership. */
export function resolveNativeWorkerOwner(expectedOwner?: string): string {
  if (expectedOwner && isAdminSupervisor()) return expectedOwner;
  const owner = nativeControlOwner(expectedOwner);
  if (expectedOwner && owner !== expectedOwner)
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native worker belongs to another principal');
  return requireNativeProfileOwner(owner);
}

/** Workspace workers may belong to an issued remote-node owner without owning the local profile. */
export function resolveReviewWorkspaceOwner(expectedOwner?: string): string {
  if (expectedOwner && isAdminSupervisor()) return expectedOwner;
  const owner = nativeControlOwner(expectedOwner);
  if (!owner || (expectedOwner && owner !== expectedOwner)) {
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Workspace review belongs to another principal');
  }
  if (process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID === owner) return owner;
  if (!nativeOwnerAssignedMachines(loadCredentialStore().principals, owner).size) {
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Workspace review requires an owned execution node',
    );
  }
  return owner;
}

export function assertNativeRunOwner(
  run: Pick<Run, 'transport' | 'nativeOwnerPrincipalId' | 'agentContexts'> &
    Pick<Partial<Run>, 'reviewWorkspaceTarget'>,
): void {
  const nativeContexts = run.agentContexts?.filter((context) => context.nativeSession) ?? [];
  if (run.transport !== 'native' && !run.nativeOwnerPrincipalId && !nativeContexts.length) return;
  if (!run.nativeOwnerPrincipalId)
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native run has no recorded profile owner');
  const owner = run.reviewWorkspaceTarget
    ? resolveReviewWorkspaceOwner(run.nativeOwnerPrincipalId)
    : resolveNativeWorkerOwner(run.nativeOwnerPrincipalId);
  if (nativeContexts.some((context) => context.nativeSession!.ownerPrincipalId !== owner))
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native context ownership does not match its run',
    );
}
