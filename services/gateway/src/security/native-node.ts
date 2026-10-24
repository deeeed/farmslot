import type { NativeExecutionNodeDeclaration, Principal } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import { loadCredentialStore } from './credential-store.js';

export function nativeNodeDeclaration(
  value: unknown,
  machine: string,
  principal: Principal | undefined,
  credentialAuthenticated: boolean,
): NativeExecutionNodeDeclaration | undefined {
  if (value === undefined) return undefined;
  // Solo-mode nodes retain their legacy capabilities, but cannot own native sessions.
  if (!credentialAuthenticated) return undefined;
  if (principal?.subject.type !== 'node' || principal.subject.machine !== machine)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native node identity must match its issued machine credential',
    );
  if (
    machine === 'local' ||
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('ownerPrincipalId' in value) ||
    typeof value.ownerPrincipalId !== 'string' ||
    !value.ownerPrincipalId.trim()
  )
    throw new GatewayMethodError(
      'INVALID_PARAMS',
      'Native node requires a distinct machine and configured owner',
    );
  const declaration: NativeExecutionNodeDeclaration = { ownerPrincipalId: value.ownerPrincipalId };
  if (principal.subject.nativeOwnerPrincipalId !== declaration.ownerPrincipalId)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native node owner must match its server-issued assignment',
    );
  const capabilities = value as Record<string, unknown>;
  for (const field of [
    'supportsEnsure',
    'supportsWorkers',
    'supportsProfiles',
    'supportsObservations',
    'supportsStructuredResults',
  ] as const) {
    const capability = capabilities[field];
    if (capability === undefined) continue;
    if (typeof capability !== 'boolean')
      throw new GatewayMethodError('INVALID_PARAMS', `Native node ${field} must be boolean`);
    declaration[field] = capability;
  }
  return declaration;
}

export function assertNativeMachineAssignment(
  machine: string,
  principal: Principal | undefined,
  principals: readonly Principal[],
): void {
  const assigned = principals.find(
    (entry) =>
      entry.subject.type === 'node' &&
      entry.subject.machine === machine &&
      entry.subject.nativeOwnerPrincipalId !== undefined,
  );
  if (assigned && assigned.id !== principal?.id)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native execution machine belongs to another issued node principal',
    );
}

/** Native execution ownership is id-only, so a replacement at a reused id never holds it. */
export function isGenerationZeroPrincipal(
  principals: readonly Principal[],
  principalId: string,
): boolean {
  return (principals.find((principal) => principal.id === principalId)?.generation ?? 0) === 0;
}

export function requireGenerationZeroOwner(
  owner: string,
  principals: readonly Principal[] = loadCredentialStore().principals,
): string {
  if (!isGenerationZeroPrincipal(principals, owner))
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      `${owner} is a replacement identity at a reused id; native execution ownership stays with the original identity, so configure another native owner.`,
    );
  return owner;
}

/** Offline inventory comes from issued assignments; remembered hello data is not authority. */
export function nativeOwnerAssignedMachines(
  principals: readonly Principal[],
  owner: string,
): Set<string> {
  if (!isGenerationZeroPrincipal(principals, owner)) return new Set();
  return new Set(
    principals.flatMap((principal) =>
      principal.subject.type === 'node' && principal.subject.nativeOwnerPrincipalId === owner
        ? [principal.subject.machine]
        : [],
    ),
  );
}
