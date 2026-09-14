import type { Run } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

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

export function assertNativeRunOwner(
  run: Pick<Run, 'transport' | 'nativeOwnerPrincipalId' | 'agentContexts'>,
): void {
  const nativeContexts = run.agentContexts?.filter((context) => context.nativeSession) ?? [];
  if (run.transport !== 'native' && !run.nativeOwnerPrincipalId && !nativeContexts.length) return;
  if (!run.nativeOwnerPrincipalId)
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native run has no recorded profile owner');
  const owner = resolveNativeWorkerOwner(run.nativeOwnerPrincipalId);
  if (nativeContexts.some((context) => context.nativeSession!.ownerPrincipalId !== owner))
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native context ownership does not match its run',
    );
}
