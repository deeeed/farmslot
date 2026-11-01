import os from 'node:os';

// gateway-auth.ts — auth probing + login flows against a gateway (ADR-036).
// Uses the shared gateway authentication and person-device session contracts.
import {
  type GatewayAuthConnectResult,
  type PairingExchangeResult,
  PersonSessionClient,
  PersonSessionEndedError,
  type PersonSessionExchangeParams,
  type SelfPrincipalSummary,
} from '@farmslot/protocol';

import {
  forgetRejectedPersonCredential,
  GatewayClient,
  GatewayConnectionError,
  type GatewayCredential,
  GatewayRpcError,
} from './gateway-client.js';
import { type GatewayProfile, type GatewayProfilesFile, saveProfiles } from './gateway-profiles.js';

export const AUTH_PROBE_TIMEOUT_MS = 5_000;

export type GatewayAuthState = 'authenticated' | 'no-auth' | 'inactive' | 'unreachable';

export interface GatewayAuthProbe {
  state: GatewayAuthState;
  authMode?: string;
  detail?: string;
  principal?: SelfPrincipalSummary;
  errorCode?: string;
}

/**
 * Probe a gateway with EXACTLY the given credential (no env fallback):
 * authenticated / no-auth (gateway requires none) / inactive (rejected or
 * missing credential) / unreachable.
 */
export async function probeGatewayAuth(
  url: string,
  credential: GatewayCredential | undefined,
  timeoutMs: number = AUTH_PROBE_TIMEOUT_MS,
): Promise<GatewayAuthProbe> {
  const client = new GatewayClient({
    url,
    timeout: timeoutMs,
    credential: credential?.personSession ? credential : null,
    // A probe reports an unreachable gateway; it does not wait out a reload.
    reconnectWindowMs: 0,
  });
  try {
    const current = credential?.personSession ? await client.currentCredentials() : credential;
    const result = await client.call<GatewayAuthConnectResult>('auth.connect', {
      clientKind: 'ui',
      clientName: 'farmslot-cli',
      ...(current?.token ? { token: current.token } : {}),
      ...(current?.password ? { password: current.password } : {}),
    });
    if (result.principal?.subjectKind === 'person' && credential?.forgetLegacyPerson) {
      await credential.forgetLegacyPerson();
      return {
        state: 'inactive',
        detail: 'Sign in again using your person credential or a pairing code.',
        errorCode: 'AUTH_PERSON_SESSION_REQUIRED',
      };
    }
    return result.authMode === 'none'
      ? { state: 'no-auth', authMode: 'none', principal: result.principal }
      : { state: 'authenticated', authMode: result.authMode, principal: result.principal };
  } catch (err) {
    await forgetRejectedPersonCredential(err, credential);
    const detail = err instanceof Error ? err.message : String(err);
    // Typed transport failure = unreachable; anything else came back from the
    // gateway and means the credential was rejected/missing.
    if (err instanceof GatewayConnectionError) {
      return { state: 'unreachable', detail };
    }
    return {
      state: 'inactive',
      detail,
      ...(err instanceof GatewayRpcError || err instanceof PersonSessionEndedError
        ? { errorCode: err.code }
        : {}),
    };
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

export function personSessionClient(
  profile: GatewayProfile,
  profiles: GatewayProfilesFile,
): PersonSessionClient {
  return new PersonSessionClient({
    storage: {
      load: async () => profile.personSession ?? null,
      save: async (value) => {
        if (value) {
          profile.personSession = value;
          profile.authMode = 'token';
        } else {
          delete profile.personSession;
          delete profile.authMode;
        }
        delete profile.secret;
        saveProfiles(profiles);
      },
    },
    request: (method, params, accessToken) =>
      new GatewayClient({
        url: profile.url,
        timeout: 5_000,
        credential: accessToken ? { token: accessToken } : null,
      }).call(method, params),
  });
}

export async function exchangePerson(
  profile: GatewayProfile,
  profiles: GatewayProfilesFile,
  input: { credential: string } | { code: string },
): Promise<string> {
  const client = personSessionClient(profile, profiles);
  const params: PersonSessionExchangeParams = {
    ...input,
    deviceName: `CLI on ${os.hostname()}`.slice(0, 128),
    deviceKind: 'cli',
  };
  try {
    return await client.exchange(params);
  } finally {
    await client.dispose();
  }
}
