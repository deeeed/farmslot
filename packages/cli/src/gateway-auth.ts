// gateway-auth.ts — auth probing + login flows against a gateway (ADR-036).
// Consumes the existing auth.connect / pairing.exchange protocol surface; no
// new gateway methods.
import type {
  GatewayAuthConnectResult,
  PairingExchangeResult,
  SelfPrincipalSummary,
} from '@farmslot/protocol';

import { GatewayClient, GatewayConnectionError } from './gateway-client.js';
import type { GatewayProfile } from './gateway-profiles.js';

export const AUTH_PROBE_TIMEOUT_MS = 5_000;

export type GatewayAuthState = 'authenticated' | 'no-auth' | 'inactive' | 'unreachable';

export interface GatewayAuthProbe {
  state: GatewayAuthState;
  authMode?: string;
  detail?: string;
  principal?: SelfPrincipalSummary;
}

/**
 * Probe a gateway with EXACTLY the given credential (no env fallback):
 * authenticated / no-auth (gateway requires none) / inactive (rejected or
 * missing credential) / unreachable.
 */
export async function probeGatewayAuth(
  url: string,
  credential: { token?: string; password?: string } | undefined,
  timeoutMs: number = AUTH_PROBE_TIMEOUT_MS,
): Promise<GatewayAuthProbe> {
  const client = new GatewayClient({ url, timeout: timeoutMs, credential: null });
  try {
    const result = await client.call<GatewayAuthConnectResult>('auth.connect', {
      clientKind: 'ui',
      clientName: 'farmslot-cli',
      ...(credential?.token ? { token: credential.token } : {}),
      ...(credential?.password ? { password: credential.password } : {}),
    });
    return result.authMode === 'none'
      ? { state: 'no-auth', authMode: 'none', principal: result.principal }
      : { state: 'authenticated', authMode: result.authMode, principal: result.principal };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Typed transport failure = unreachable; anything else came back from the
    // gateway and means the credential was rejected/missing.
    if (err instanceof GatewayConnectionError) {
      return { state: 'unreachable', detail };
    }
    return { state: 'inactive', detail };
  }
}

/** Exchange a pairing code (shown by Command Center) for a credential. */
export async function exchangePairingCode(
  url: string,
  code: string,
  timeoutMs: number = AUTH_PROBE_TIMEOUT_MS,
): Promise<PairingExchangeResult['profile']> {
  const client = new GatewayClient({ url, timeout: timeoutMs, credential: null });
  const result = await client.call<PairingExchangeResult>('pairing.exchange', { code });
  return result.profile;
}

/** Human-facing summary line for a probe; never includes secrets. */
export function describeProbe(
  profileName: string,
  profile: GatewayProfile,
  probe: GatewayAuthProbe,
): string {
  switch (probe.state) {
    case 'authenticated':
      return `${profileName}: authenticated (${probe.authMode})${formatPrincipal(probe.principal)} at ${profile.url}`;
    case 'no-auth':
      return `${profileName}: reachable, no auth required${formatPrincipal(probe.principal)} at ${profile.url}`;
    case 'inactive':
      return `${profileName}: not signed in at ${profile.url}${probe.detail ? ` — ${probe.detail}` : ''}`;
    case 'unreachable':
      return `${profileName}: unreachable at ${profile.url}${probe.detail ? ` — ${probe.detail}` : ''}`;
  }
}

function formatPrincipal(principal: SelfPrincipalSummary | undefined): string {
  if (!principal) return '';
  const roles = principal.roles.length
    ? principal.roles.map((binding) => `${binding.role}:${binding.scope.kind}`).join(',')
    : 'no roles';
  return ` as ${principal.displayName} [${roles}]`;
}
