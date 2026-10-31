import { isRecord } from '../recipe/common.js';

import type { RoleBinding, SelfPrincipalSummary } from './principal.js';
import { Methods } from './registry.js';
import type { ResourceObserversCapability } from './resource-observers.js';

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

/** Experimental ADR-071 notification capability, present on every new gateway connect reply. */
export interface GatewayResourceChangesCapability {
  /** Dispatch verifies node producer admission for source-backed observed reads. */
  observedReads?: 1;
  workspaceReads?: 1;
  version: 1;
  epoch: string;
  versionLists: boolean;
  /** Advertise only once the named read stamps, collector writers and admission work together. */
  upstreamObservers?: ResourceObserversCapability;
}

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
    personSessions?: boolean;
    /** Client shell selection; every RPC still checks current server authority. */
    workspaceAccess?: GatewayWorkspaceAccess;
    /** Absent only on gateways predating ADR-071. */
    resourceChanges?: GatewayResourceChangesCapability;
    batchedContent?: boolean;
    /** `expectedHash` and `runId` on file edits, and `hash` on `fs.read`. Experimental. */
    conditionalFileWrites?: boolean;
    /**
     * Terminal input `seq` is honoured: each batch number is typed into a pane once, and the pane
     * keeps that record across gateway restarts, so a client resends a batch whatever its answer.
     * `instance` changes with each gateway process; clients from before pane records compare it.
     */
    terminalInputSequence?: { instance: string };
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

/** URL schemes of the Companion builds; production, preview and development install side by side. */
export const COMPANION_APP_SCHEMES = [
  'farmslot',
  'farmslot-preview',
  'farmslot-development',
] as const;
export type CompanionAppScheme = (typeof COMPANION_APP_SCHEMES)[number];

/**
 * A link that pairs Companion as if this QR were scanned, with the same single-use code and expiry.
 * The payload is percent-encoded down to [A-Za-z0-9._~-], so the link passes through a device shell
 * (`adb shell am start -d`) unchanged.
 */
export function buildGatewayPairingLink(
  payload: GatewayPairingQrPayload,
  scheme: CompanionAppScheme = 'farmslot',
): string {
  const encoded = encodeURIComponent(JSON.stringify(payload)).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${scheme}://pair?payload=${encoded}`;
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

/** Shared validation for sign-in metadata at every writer and client boundary. */
export function parsePersonDeviceDescription(value: unknown): PersonDeviceDescription | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!('deviceName' in value) || typeof value.deviceName !== 'string' || !('deviceKind' in value))
    return null;
  const deviceName = value.deviceName.trim();
  const deviceKind = PERSON_DEVICE_KINDS.find((kind) => kind === value.deviceKind);
  return deviceName && deviceName.length <= 128 && deviceKind ? { deviceName, deviceKind } : null;
}

export function parsePersonSessionToken(
  value: string,
  kind: 'fsa' | 'fsr',
): { id: string; secret: string } | null {
  const match = /^(fsa|fsr)_([a-f0-9]{32})_([A-Za-z0-9_-]{43})$/u.exec(value);
  return match?.[1] === kind ? { id: match[2], secret: match[3] } : null;
}

export function parsePersonDeviceSession(value: unknown): PersonDeviceSession | null {
  if (!isRecord(value)) return null;
  const device = parsePersonDeviceDescription(value);
  if (
    !device ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(value.id) ||
    typeof value.principalId !== 'string' ||
    !value.principalId.trim() ||
    typeof value.principalGeneration !== 'number' ||
    !Number.isSafeInteger(value.principalGeneration) ||
    value.principalGeneration < 0 ||
    !sessionTimestamp(value.createdAt) ||
    !sessionTimestamp(value.lastRefreshedAt) ||
    !sessionTimestamp(value.refreshExpiresAt) ||
    (value.revokedAt !== null && !sessionTimestamp(value.revokedAt))
  )
    return null;
  return {
    ...device,
    id: value.id,
    principalId: value.principalId,
    principalGeneration: value.principalGeneration,
    createdAt: value.createdAt,
    lastRefreshedAt: value.lastRefreshedAt,
    refreshExpiresAt: value.refreshExpiresAt,
    revokedAt: value.revokedAt,
  };
}

/** Storage adapters never accept an access token as a persisted session. */
export function parsePersonSessionAuth(value: unknown): PersonSessionAuth | null {
  if (!isRecord(value) || 'accessToken' in value || typeof value.refreshToken !== 'string')
    return null;
  const session = parsePersonDeviceSession(value.session);
  const token = parsePersonSessionToken(value.refreshToken, 'fsr');
  return session && token?.id === session.id ? { session, refreshToken: value.refreshToken } : null;
}

export function parsePersonSessionGrant(value: unknown): PersonSessionGrant | null {
  if (
    !isRecord(value) ||
    typeof value.accessToken !== 'string' ||
    !sessionTimestamp(value.accessExpiresAt)
  )
    return null;
  const saved = parsePersonSessionAuth({
    session: value.session,
    refreshToken: value.refreshToken,
  });
  if (
    !saved ||
    !parsePersonSessionToken(value.accessToken, 'fsa') ||
    saved.session.revokedAt !== null
  )
    return null;
  return { ...saved, accessToken: value.accessToken, accessExpiresAt: value.accessExpiresAt };
}

function sessionTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}
