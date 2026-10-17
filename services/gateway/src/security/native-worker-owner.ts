import { isTerminalRunStatus, type Run } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

import { isAdminPrincipal } from './authorization.js';
import { loadCredentialStore } from './credential-store.js';
import { isGenerationZeroPrincipal, nativeOwnerAssignedMachines } from './native-node.js';
import { currentSessionOriginator, currentSessionPrincipal } from './work-originator.js';

function nativeControlOwner(expectedOwner?: string): string | undefined {
  const originator = currentSessionOriginator();
  if (originator.kind !== 'principal') return expectedOwner;
  return originator.principalId;
}

export function isAdminSupervisor(): boolean {
  const principal = currentSessionPrincipal();
  // Supervision authorizes the caller without adopting the runner's identity.
  return principal?.subject.type === 'person' && isAdminPrincipal(principal);
}

/** Native execution ownership never passes to a replacement at a reused id. */
function requireGenerationZeroOwner(owner: string): string {
  if (!isGenerationZeroPrincipal(loadCredentialStore().principals, owner))
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      `${owner} is a replacement identity at a reused id; native execution ownership stays with the original identity, so configure another native owner.`,
    );
  return owner;
}

export function requireNativeProfileOwner(principalId: string | undefined): string {
  const configured = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
  if (!configured || !principalId || principalId !== configured)
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Native execution requires this principal to own the configured native runner profile',
    );
  return requireGenerationZeroOwner(principalId);
}

/** Network requests use their authenticated principal; internal continuations need stored ownership. */
export function resolveNativeWorkerOwner(expectedOwner?: string): string {
  // Supervision checks the stored owner, never the supervising caller.
  if (expectedOwner && isAdminSupervisor()) return requireGenerationZeroOwner(expectedOwner);
  const owner = nativeControlOwner(expectedOwner);
  if (expectedOwner && owner !== expectedOwner)
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Native worker belongs to another principal');
  return requireNativeProfileOwner(owner);
}

/** Workspace workers may belong to an issued remote-node owner without owning the local profile. */
export function resolveReviewWorkspaceOwner(expectedOwner?: string): string {
  if (expectedOwner && isAdminSupervisor()) return requireGenerationZeroOwner(expectedOwner);
  const owner = nativeControlOwner(expectedOwner);
  if (!owner || (expectedOwner && owner !== expectedOwner)) {
    throw new GatewayMethodError('AUTH_FORBIDDEN', 'Workspace review belongs to another principal');
  }
  requireGenerationZeroOwner(owner);
  if (process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID === owner) return owner;
  if (!nativeOwnerAssignedMachines(loadCredentialStore().principals, owner).size) {
    throw new GatewayMethodError(
      'AUTH_FORBIDDEN',
      'Workspace review requires an owned execution node',
    );
  }
  return owner;
}

export interface StaticReviewOwner {
  ownerId: string;
  /** Present only when an admin person delegated authorship to the native owner. */
  requester?: { principalId: string; principalGeneration?: number };
}

/**
 * `live` marks a request an authenticated admin is making now; a queued
 * delegated row replays the owner it recorded. Anything else never delegates.
 */
export type StaticReviewDelegation = 'live' | { ownerId: string };

function sessionRequester(): StaticReviewOwner['requester'] {
  const originator = currentSessionOriginator();
  return originator.kind === 'principal'
    ? {
        principalId: originator.principalId,
        ...(originator.principalGeneration
          ? { principalGeneration: originator.principalGeneration }
          : {}),
      }
    : undefined;
}

/**
 * The owner of a new static review. An admin person whose own resolution is
 * refused may delegate authorship: the review runs and publishes as the
 * configured native owner, and the person is recorded only as its requester.
 */
export function resolveStaticReviewOwner(delegation?: StaticReviewDelegation): StaticReviewOwner {
  if (delegation && delegation !== 'live') {
    if (!isAdminSupervisor())
      throw new GatewayMethodError(
        'AUTH_FORBIDDEN',
        'Delegated static review requires its requester to remain an admin person',
      );
    return {
      ownerId: resolveReviewWorkspaceOwner(delegation.ownerId),
      requester: sessionRequester(),
    };
  }
  try {
    return { ownerId: resolveReviewWorkspaceOwner() };
  } catch (error) {
    const configured = process.env.FARMSLOT_NATIVE_OWNER_PRINCIPAL_ID;
    if (
      delegation !== 'live' ||
      !configured ||
      !isAdminSupervisor() ||
      !(error instanceof GatewayMethodError)
    )
      throw error;
    return { ownerId: resolveReviewWorkspaceOwner(configured), requester: sessionRequester() };
  }
}

/**
 * The owner a new run inherits from its parent. A finished run of a retired
 * principal is history, not current ownership, so the new run resolves its own
 * owner. Live parents and reused ids (no longer listed as retired) keep the
 * parent's owner and its guards.
 */
export function inheritableParentOwner(
  parent: Pick<Run, 'status' | 'nativeOwnerPrincipalId'> | undefined,
): string | undefined {
  const owner = parent?.nativeOwnerPrincipalId;
  if (!owner || !isTerminalRunStatus(parent.status)) return owner;
  return loadCredentialStore().retiredPrincipalIds?.includes(owner) ? undefined : owner;
}

export function assertNativeRunOwner(
  run: Pick<Run, 'transport' | 'nativeOwnerPrincipalId' | 'agentContexts'> &
    Pick<Partial<Run>, 'reviewWorkspaceTarget'>,
): void {
  const nativeContexts = run.agentContexts?.filter((context) => context.nativeSession) ?? [];
  if (run.transport !== 'native' && !run.nativeOwnerPrincipalId) {
    for (const context of nativeContexts) {
      if (context.role !== 'review' || context.nativeSessionOwner)
        throw new GatewayMethodError(
          'AUTH_FORBIDDEN',
          'Only independent reviewers may use native sessions on this worker transport',
        );
      resolveReviewWorkspaceOwner(context.nativeSession!.ownerPrincipalId);
    }
    return;
  }
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
