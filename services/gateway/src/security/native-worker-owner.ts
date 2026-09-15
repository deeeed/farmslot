import type { Run } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import { loadCredentialStore } from './credential-store.js';
import { nativeOwnerAssignedMachines } from './native-node.js';
import { currentSessionOriginator } from './work-originator.js';

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
  const originator = currentSessionOriginator();
  const owner = originator.kind === 'principal' ? originator.principalId : expectedOwner;
  if (expectedOwner && owner !== expectedOwner)
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native worker belongs to another principal');
  return requireNativeProfileOwner(owner);
}

/** Workspace workers may belong to an issued remote-node owner without owning the local profile. */
export function resolveReviewWorkspaceOwner(expectedOwner?: string): string {
  const originator = currentSessionOriginator();
  const owner = originator.kind === 'principal' ? originator.principalId : expectedOwner;
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
