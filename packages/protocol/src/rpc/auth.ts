import type { RoleBinding, SelfPrincipalSummary } from './principal.js';
import { Methods } from './registry.js';

export const AuthMethods = {
  connect: Methods.AUTH_CONNECT,
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
