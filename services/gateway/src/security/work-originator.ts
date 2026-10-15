import { AsyncLocalStorage } from 'node:async_hooks';

import type { Principal } from '@farmslot/protocol';

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

const sessionOriginator = new AsyncLocalStorage<WorkOriginator>();

export function runWithSessionOriginator<T>(principal: Principal, operation: () => T): T {
  return sessionOriginator.run(principalWorkOriginator(principal), operation);
}

/** Background scheduling must not adopt the user whose unrelated event woke it. */
export function runWithSystemOriginator<T>(operation: () => T): T {
  return sessionOriginator.run({ kind: 'system' }, operation);
}

export function currentSessionOriginator(): WorkOriginator {
  // Every network route is entered through runWithSessionOriginator. The
  // fallback preserves direct in-process maintenance callers without making
  // the system principal reachable from an ingress.
  return sessionOriginator.getStore() ?? { kind: 'system' };
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
