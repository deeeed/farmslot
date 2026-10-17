import { AsyncLocalStorage } from 'node:async_hooks';

import type { Principal, Run } from '@farmslot/protocol';

import type { GatewayAuthRuntime, GatewayAuthSession } from './auth.js';
import { systemWorkPrincipal } from './principal-resolver.js';

export type WorkOriginator =
  | { kind: 'principal'; principalId: string; principalGeneration?: number }
  | { kind: 'system' };

export function principalWorkOriginator(principal: Principal): WorkOriginator {
  return {
    kind: 'principal',
    principalId: principal.id,
    ...(principal.generation !== undefined ? { principalGeneration: principal.generation } : {}),
  };
}

interface SessionWorkContext {
  originator: WorkOriginator;
  principal?: Principal;
}

const sessionOriginator = new AsyncLocalStorage<SessionWorkContext>();

export function runWithSessionOriginator<T>(principal: Principal, operation: () => T): T {
  return sessionOriginator.run(
    { originator: principalWorkOriginator(principal), principal },
    operation,
  );
}

/** Background scheduling must not adopt the user whose unrelated event woke it. */
export function runWithSystemOriginator<T>(operation: () => T): T {
  return sessionOriginator.run({ originator: { kind: 'system' } }, operation);
}

export function currentSessionOriginator(): WorkOriginator {
  // Every network route is entered through runWithSessionOriginator. The
  // fallback preserves direct in-process maintenance callers without making
  // the system principal reachable from an ingress.
  return sessionOriginator.getStore()?.originator ?? { kind: 'system' };
}

/** Current authenticated authority is request-local, never persisted with work authorship. */
export function currentSessionPrincipal(): Principal | undefined {
  return sessionOriginator.getStore()?.principal;
}

/** A stored owner without a generation belongs to the original identity. */
export interface PrincipalOwner {
  ownerId: string;
  ownerGeneration?: number;
}

export function principalOwnerGeneration(ownerId: string): number {
  const originator = currentSessionOriginator();
  return originator.kind === 'principal' && originator.principalId === ownerId
    ? (originator.principalGeneration ?? 0)
    : 0;
}

export function principalIdentityKey(ownerId: string): string {
  const generation = principalOwnerGeneration(ownerId);
  return generation > 0 ? principalOwnerKey({ ownerId, ownerGeneration: generation }) : ownerId;
}

export function principalOwnerKey(owner: PrincipalOwner): string {
  return JSON.stringify([owner.ownerId, owner.ownerGeneration ?? 0]);
}

export function principalOwnerStamp(ownerId: string): Pick<PrincipalOwner, 'ownerGeneration'> {
  const generation = principalOwnerGeneration(ownerId);
  return generation > 0 ? { ownerGeneration: generation } : {};
}

export function samePrincipalOwner(left: PrincipalOwner, right: PrincipalOwner): boolean {
  return (
    left.ownerId === right.ownerId && (left.ownerGeneration ?? 0) === (right.ownerGeneration ?? 0)
  );
}

/** The creator owns delayed PR follow-ups; native-only legacy records remain generation zero. */
export function runPrincipalOwner(
  run: Pick<
    Run,
    'createdByPrincipalId' | 'createdByPrincipalGeneration' | 'nativeOwnerPrincipalId' | 'prWork'
  >,
): PrincipalOwner | undefined {
  if (run.createdByPrincipalId)
    return { ownerId: run.createdByPrincipalId, ownerGeneration: run.createdByPrincipalGeneration };
  if (run.prWork?.review) return run.prWork.review;
  return run.nativeOwnerPrincipalId ? { ownerId: run.nativeOwnerPrincipalId } : undefined;
}

export function matchesPrincipalOwner(owner: PrincipalOwner, ownerId: string): boolean {
  if (owner.ownerId !== ownerId) return false;
  const originator = currentSessionOriginator();
  // Internal maintenance reads do not grant authority. Effect guards separately
  // resolve the exact stored generation; network reads are session-scoped here.
  return originator.kind !== 'principal' || originator.principalId !== ownerId
    ? true
    : samePrincipalOwner(owner, { ownerId, ...principalOwnerStamp(ownerId) });
}

export function runWithPrincipalOwner<T>(owner: PrincipalOwner, operation: () => T): T {
  // Resumed authorship carries no request principal, so it never supervises.
  return sessionOriginator.run({ originator: principalOwnerOriginator(owner) }, operation);
}

/** Resume durable work's exact authorship; the caller must still authorize its effects. */
export function runWithWorkOriginator<T>(originator: WorkOriginator, operation: () => T): T {
  return sessionOriginator.run({ originator }, operation);
}

export function principalOwnerOriginator(owner: PrincipalOwner): WorkOriginator {
  return {
    kind: 'principal',
    principalId: owner.ownerId,
    ...(owner.ownerGeneration !== undefined ? { principalGeneration: owner.ownerGeneration } : {}),
  };
}

export function workAuthorshipNotice(
  previous: WorkOriginator | undefined,
  next: WorkOriginator,
): string | undefined {
  if (!previous || JSON.stringify(previous) === JSON.stringify(next)) return undefined;
  return (
    'This item was re-authored by your authenticated principal; ' +
    'fire-time authorization now uses your current authority.'
  );
}

export function resolveWorkOriginator(
  runtime: GatewayAuthRuntime,
  originator: WorkOriginator | undefined,
): Principal | null {
  if (!originator) return null;
  if (originator.kind === 'system') return systemWorkPrincipal();
  const resolution = runtime.resolver.resolvePrincipalId(
    originator.principalId,
    originator.principalGeneration,
  );
  return resolution.ok ? resolution.principal : null;
}

/** The id a stored originator names when an explicit reuse replaced that identity. */
export function replacedWorkOriginator(
  runtime: GatewayAuthRuntime,
  originator: WorkOriginator | undefined,
): string | undefined {
  if (originator?.kind !== 'principal') return undefined;
  const resolution = runtime.resolver.resolvePrincipalId(
    originator.principalId,
    originator.principalGeneration,
  );
  return !resolution.ok && resolution.reason === 'generation_mismatch'
    ? originator.principalId
    : undefined;
}

/** Stored identity generation: omitted for zero, otherwise a positive safe integer. */
export const ownerGenerationSchema = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};

/** Owners and their generations are gateway-derived; a request never supplies them. */
export function assertNoClientOwnerFields(params: Record<string, unknown>): void {
  for (const key of ['ownerId', 'ownerGeneration', 'notificationPrincipalGenerations'])
    if (key in params) throw new Error(`Unsupported property: ${key}`);
}

export function isWorkOriginator(value: unknown): value is WorkOriginator {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === 'system' ||
    (candidate.kind === 'principal' &&
      typeof candidate.principalId === 'string' &&
      candidate.principalId.length > 0 &&
      (candidate.principalGeneration === undefined ||
        (Number.isSafeInteger(candidate.principalGeneration) &&
          (candidate.principalGeneration as number) > 0)))
  );
}

export function sessionOriginatorFor(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
): WorkOriginator {
  const resolution = runtime.resolver.resolveSessionPrincipal(session);
  if (!resolution.ok) throw new Error('Cannot stamp work without an authenticated principal');
  return principalWorkOriginator(resolution.principal);
}
