import type { NativeExecutionNodeDeclaration, Principal } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

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
  const supportsEnsure = 'supportsEnsure' in value ? value.supportsEnsure : undefined;
  if (supportsEnsure !== undefined && typeof supportsEnsure !== 'boolean')
    throw new GatewayMethodError('INVALID_PARAMS', 'Native node supportsEnsure must be boolean');
  return {
    ownerPrincipalId: value.ownerPrincipalId,
    ...(supportsEnsure !== undefined ? { supportsEnsure } : {}),
  };
}
