import {
  CredentialStoreRefusalError,
  type PersonSessionAuthority,
} from '@farmslot/credential-store';
import { Methods, parsePersonDeviceDescription } from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import { pairingExchangePersonSession } from '../fleet/pairing.js';

import { authRateLimitApplies, type GatewayAuthRuntime, type GatewayAuthSession } from './auth.js';

export const personSessionMethods = new Set<string>([
  Methods.AUTH_SESSION_EXCHANGE,
  Methods.AUTH_SESSION_REFRESH,
  Methods.AUTH_SESSION_LIST,
  Methods.AUTH_SESSION_REVOKE,
]);

/** Authentication entry points own their credential proof, not the farm-role allowlist. */
export function routePersonSessionMethod(
  method: string,
  value: unknown,
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
  clientIp: string,
): unknown {
  if (!isRecord(value)) throw invalid();
  const unauthenticated =
    method === Methods.AUTH_SESSION_EXCHANGE || method === Methods.AUTH_SESSION_REFRESH;
  const limited = unauthenticated && authRateLimitApplies(runtime, clientIp);
  if (limited && runtime.limiter.check(clientIp))
    throw new GatewayMethodError(
      'AUTH_RATE_LIMITED',
      'Too many sign-in attempts. Try again shortly.',
    );
  try {
    let result: unknown;
    switch (method) {
      case Methods.AUTH_SESSION_EXCHANGE: {
        keys(value, ['credential', 'code', 'deviceName', 'deviceKind']);
        const device = parsePersonDeviceDescription(value);
        if (!device || 'credential' in value === 'code' in value) throw invalid();
        result =
          'credential' in value
            ? runtime.writer.exchangePersonCredential(text(value.credential), device)
            : pairingExchangePersonSession(text(value.code), device, runtime);
        break;
      }
      case Methods.AUTH_SESSION_REFRESH:
        keys(value, ['refreshToken']);
        result = runtime.writer.refreshPersonSession(text(value.refreshToken));
        break;
      case Methods.AUTH_SESSION_LIST:
        keys(value, []);
        result = { sessions: runtime.writer.listPersonSessions(personAuthority(runtime, session)) };
        break;
      case Methods.AUTH_SESSION_REVOKE:
        keys(value, ['sessionId']);
        result = {
          session: runtime.writer.revokePersonSession(
            personAuthority(runtime, session),
            text(value.sessionId),
          ),
        };
        break;
      default:
        throw new GatewayMethodError('METHOD_NOT_FOUND', 'Unknown person-session method.');
    }
    if (limited) runtime.limiter.reset(clientIp);
    return result;
  } catch (error) {
    if (limited) runtime.limiter.recordFailure(clientIp);
    if (error instanceof CredentialStoreRefusalError)
      throw new GatewayMethodError(error.diagnostic ?? 'AUTH_FAILED', error.message);
    throw error;
  }
}

function personAuthority(
  runtime: GatewayAuthRuntime,
  session: GatewayAuthSession,
): PersonSessionAuthority {
  const resolved = runtime.resolver.resolveSessionPrincipal(session);
  const reference = session.authentication;
  if (!resolved.ok)
    throw new GatewayMethodError(
      'AUTH_SESSION_ENDED',
      'Your device sign-in has ended. Sign in again.',
    );
  if (resolved.principal.subject.type !== 'person' || reference?.kind !== 'person-session')
    throw new GatewayMethodError(
      'AUTH_PERSON_REQUIRED',
      'Sign in as a person to manage signed-in devices.',
    );
  return {
    principalId: resolved.principal.id,
    principalGeneration: resolved.principal.generation ?? 0,
    sessionId: reference.sessionId,
    accessId: reference.accessId,
  };
}

function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw invalid();
  return value.trim();
}

function invalid(): GatewayMethodError {
  return new GatewayMethodError('INVALID_PARAMS', 'Provide the required sign-in or device fields.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
