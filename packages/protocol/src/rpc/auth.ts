import type { RoleBinding, SelfPrincipalSummary } from './principal.js';
import { Methods } from './registry.js';

export const AuthMethods = {
  connect: Methods.AUTH_CONNECT,
  sessionExchange: Methods.AUTH_SESSION_EXCHANGE,
  sessionRefresh: Methods.AUTH_SESSION_REFRESH,
  sessionList: Methods.AUTH_SESSION_LIST,
  sessionRevoke: Methods.AUTH_SESSION_REVOKE,
} as const;

export type GatewayAuthClientKind = 'ui' | 'companion' | 'node';
export type GatewayAuthMode = 'none' | 'token' | 'password';
export type GatewayWorkspaceAccess = 'farm' | 'native' | 'none';

export interface GatewayAuthConnectParams {
  clientKind: GatewayAuthClientKind;
  token?: string;
  password?: string;
  clientName?: string;
  protocolVersion?: string;
}

export interface GatewayAuthConnectResult {
  ok: true;
  clientKind: GatewayAuthClientKind;
  authMode: GatewayAuthMode;
  authenticatedAt: number;
  capabilities: {
    httpBearerAuth: boolean;
    voiceInstructionFormatting: boolean;
    /** Absent on gateways predating the lightweight liveness method. */
    gatewayPing?: boolean;
    /** Client shell selection; every RPC still checks current server authority. */
    workspaceAccess?: GatewayWorkspaceAccess;
  };
  /** Optional only for compatibility with older gateways. */
  principal?: SelfPrincipalSummary;
}

/** Shared client compatibility policy. Every gateway request still checks authority. */
export function workspaceAccessFromAuth(result: GatewayAuthConnectResult): GatewayWorkspaceAccess {
  const explicit = result.capabilities.workspaceAccess;
  if (explicit !== undefined)
    return explicit === 'farm' || explicit === 'native' ? explicit : 'none';
  if (!result.principal) return 'farm';
  if (result.principal.subjectKind === 'node') return 'none';
  return result.principal.roles.some(
    ({ role, scope }) => (role === 'admin' || role === 'operator') && scope.kind === 'global',
  )
    ? 'farm'
    : 'none';
}

export type PairingAuthority =
  | { kind: 'existing-principal'; principalId: string }
  | { kind: 'new-service-principal'; displayName: string; roles: RoleBinding[] };

export interface PairingCreateParams {
  gatewayUrl: string;
  profileName?: string;
  ttlSeconds?: number;
  authority: PairingAuthority;
}

export interface PairingCreateResult {
  url: string;
  code: string;
  profileName: string;
  expiresAt: string;
}

export const GATEWAY_PAIRING_QR_TYPE = 'farmslot.gateway-pairing.v1' as const;

export interface GatewayPairingQrProfile {
  url: string;
  code: string;
  profileName?: string;
  expiresAt?: string;
}

export interface GatewayPairingQrPayload {
  type: typeof GATEWAY_PAIRING_QR_TYPE;
  profiles: GatewayPairingQrProfile[];
}

export interface GatewayPairingQrTarget {
  gatewayUrl: string;
  profileName?: string;
}

export function buildGatewayPairingQrPayload(
  pairing: PairingCreateResult,
  targets: GatewayPairingQrTarget[],
): GatewayPairingQrPayload {
  if (targets.length === 0) throw new Error('Pairing QR requires at least one profile');
  return {
    type: GATEWAY_PAIRING_QR_TYPE,
    profiles: targets.map((target) => ({
      url: target.gatewayUrl,
      code: pairing.code,
      profileName: target.profileName?.trim() || pairing.profileName,
      expiresAt: pairing.expiresAt,
    })),
  };
}

export interface PairingCandidatesParams {
  port?: number;
}

export interface PairingCandidate {
  gatewayUrl: string;
  profileName: string;
  kind: 'lan' | 'tailnet';
}

export interface PairingCandidatesResult {
  candidates: PairingCandidate[];
}

export interface PairingExchangeParams {
  code: string;
}

export interface PairingExchangeResult {
  profile: {
    name: string;
    url: string;
    authMode: Exclude<GatewayAuthMode, 'none'>;
    secret: string;
  };
  expiresAt: string;
}

/** Metadata never authenticates a caller; the gateway resolves the record live. */
export const PERSON_DEVICE_KINDS = ['command-center', 'companion', 'cli'] as const;
export type PersonDeviceKind = (typeof PERSON_DEVICE_KINDS)[number];

export interface PersonDeviceDescription {
  deviceName: string;
  deviceKind: PersonDeviceKind;
}

export interface PersonDeviceSession extends PersonDeviceDescription {
  id: string;
  principalId: string;
  principalGeneration: number;
  createdAt: string;
  lastRefreshedAt: string;
  refreshExpiresAt: string;
  revokedAt: string | null;
}

/** The only person authentication value permitted in persistent client storage. */
export interface PersonSessionAuth {
  session: PersonDeviceSession;
  refreshToken: string;
}

/** Access tokens remain in memory. Never persist this complete grant. */
export interface PersonSessionGrant extends PersonSessionAuth {
  accessToken: string;
  accessExpiresAt: string;
}

export type PersonSessionExchangeParams = PersonDeviceDescription &
  ({ credential: string; code?: never } | { code: string; credential?: never });
export type PersonSessionExchangeResult = PersonSessionGrant;
export interface PersonSessionRefreshParams {
  refreshToken: string;
}
export type PersonSessionRefreshResult = PersonSessionGrant;
export interface PersonSessionListParams {}
export interface PersonSessionListResult {
  sessions: PersonDeviceSession[];
}
export interface PersonSessionRevokeParams {
  sessionId: string;
}
export interface PersonSessionRevokeResult {
  session: PersonDeviceSession;
}
