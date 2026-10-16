import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';

import { CredentialStoreRefusalError } from '@farmslot/credential-store';
import {
  type PairingAuthority,
  type PairingCandidate,
  type PairingCandidatesParams,
  type PairingCandidatesResult,
  type PairingCreateParams,
  type PairingCreateResult,
  type PairingExchangeParams,
  type PairingExchangeResult,
  parseTailscaleDnsNameFromStatus,
  type PersonDeviceDescription,
  type PersonSessionGrant,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';
import type { GatewayAuthRuntime } from '../security/auth.js';

interface PairingRecord {
  code: string;
  gatewayUrl: string;
  profileName: string;
  expiresAtMs: number;
  authority: PairingAuthority;
  principalGeneration?: number;
}

const pairings = new Map<string, PairingRecord>();
const DEFAULT_TTL_SECONDS = 120;
const MAX_TTL_SECONDS = 600;

export function pairingCandidates(params: PairingCandidatesParams = {}): PairingCandidatesResult {
  const port = Number(params.port || process.env.GATEWAY_PORT || 7777);
  return { candidates: reachablePairingCandidates(Number.isFinite(port) ? port : 7777) };
}

export function reachablePairingCandidates(
  port: number,
  interfaces = networkInterfaces(),
  tailnet = tailscaleDnsName(),
  host = hostname().replace(/\.local$/, ''),
): PairingCandidate[] {
  const lan: string[] = [];
  const publicAddresses: string[] = [];
  const tailnetAddresses: string[] = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const ip = entry.address;
      // Tailscale uses 100.64/10 and can itself live on a macOS utun interface.
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) {
        tailnetAddresses.push(ip);
        continue;
      }
      if (
        /^(utun|tun|tap|wg|ppp|ipsec)/i.test(name) ||
        /^10\.8\./.test(ip) ||
        /^169\.254\./.test(ip)
      )
        continue;
      const isPrivate =
        /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      (isPrivate ? lan : publicAddresses).push(ip);
    }
  }
  const candidates: PairingCandidate[] = [];
  if (tailnet)
    candidates.push({
      gatewayUrl: `ws://${tailnet}:${port}/ws`,
      profileName: `${host} (Tailscale)`,
      kind: 'tailnet',
    });
  for (const ip of new Set(tailnetAddresses)) {
    candidates.push({
      gatewayUrl: `ws://${ip}:${port}/ws`,
      profileName: `${host} (Tailscale)`,
      kind: 'tailnet',
    });
  }
  for (const ip of new Set(lan.length ? lan : publicAddresses)) {
    candidates.push({
      gatewayUrl: `ws://${ip}:${port}/ws`,
      profileName: `${host} (LAN)`,
      kind: 'lan',
    });
  }
  return candidates;
}

function tailscaleDnsName(): string | null {
  const result = spawnSync('tailscale', ['status', '--json'], {
    encoding: 'utf-8',
    timeout: 4000,
  });
  if (result.error || result.status !== 0) return null;
  return parseTailscaleDnsNameFromStatus(result.stdout);
}

export function pairingCreate(
  params: PairingCreateParams,
  runtime: GatewayAuthRuntime,
): PairingCreateResult {
  if (typeof params?.gatewayUrl !== 'string') {
    throw new Error('pairing.create requires gatewayUrl');
  }
  const gatewayUrl = params.gatewayUrl.trim();
  if (!gatewayUrl.startsWith('ws://') && !gatewayUrl.startsWith('wss://')) {
    throw new Error('pairing.create requires gatewayUrl starting with ws:// or wss://');
  }
  if (!params.authority || typeof params.authority !== 'object') {
    throw new Error('pairing.create requires authority');
  }
  if (runtime.resolver.isSoloMode()) {
    throw new Error(
      'Pairing requires an activated gateway with an active admin credential; issue the owner credential first.',
    );
  }
  let principalGeneration: number | undefined;
  if (params.authority.kind === 'existing-principal') {
    if (typeof params.authority.principalId !== 'string' || !params.authority.principalId) {
      throw new Error('existing-principal authority requires principalId');
    }
    const principal = runtime.store.findPrincipal(params.authority.principalId);
    if (!principal) {
      throw new Error(`Pairing principal '${params.authority.principalId}' does not exist`);
    }
    principalGeneration = principal.generation ?? 0;
  } else if (params.authority.kind === 'new-service-principal') {
    if (
      typeof params.authority.displayName !== 'string' ||
      !params.authority.displayName.trim() ||
      !validPairingRoles(params.authority.roles)
    ) {
      throw new Error('new-service-principal authority requires displayName and roles');
    }
  } else {
    throw new Error('pairing.create authority kind is invalid');
  }

  const requestedTtl = Number(params.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  if (!Number.isFinite(requestedTtl)) throw new Error('pairing.create ttlSeconds must be numeric');
  const ttlSeconds = Math.min(Math.max(requestedTtl, 30), MAX_TTL_SECONDS);
  const code = randomBytes(24).toString('base64url');
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  const profileName = params.profileName?.trim() || 'Farmslot Remote';
  pairings.set(code, {
    code,
    gatewayUrl,
    profileName,
    expiresAtMs,
    authority: structuredClone(params.authority),
    ...(principalGeneration !== undefined ? { principalGeneration } : {}),
  });
  pruneExpiredPairings();
  return {
    url: gatewayUrl,
    code,
    profileName,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function validPairingRoles(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (binding) =>
        binding !== null &&
        typeof binding === 'object' &&
        ((binding as { role?: unknown }).role === 'admin' ||
          (binding as { role?: unknown }).role === 'operator') &&
        (binding as { scope?: { kind?: unknown } }).scope?.kind === 'global',
    )
  );
}

export function pairingExchange(
  params: PairingExchangeParams,
  runtime: GatewayAuthRuntime,
): PairingExchangeResult {
  const record = livePairingRecord(params?.code);
  const code = record.code;
  if (
    record.authority.kind === 'existing-principal' &&
    runtime.store.findPrincipal(record.authority.principalId)?.subject.type === 'person'
  )
    throw new GatewayMethodError(
      'AUTH_PERSON_SESSION_REQUIRED',
      'Sign in using a current Farmslot client.',
    );
  let issue;
  try {
    issue =
      record.authority.kind === 'existing-principal'
        ? runtime.writer.issueCredential(
            record.authority.principalId,
            record.profileName,
            'paired',
            record.principalGeneration,
          )
        : runtime.writer.provisionPairedServicePrincipal(
            record.authority.displayName,
            record.authority.roles,
            record.profileName,
          );
  } catch (error) {
    if (!(error instanceof CredentialStoreRefusalError)) throw error;
    // An invalid grant cannot become valid later. Infrastructure failures keep
    // the code available for retry and still propagate to the caller.
    pairings.delete(code);
    throw new GatewayMethodError('PAIRING_FAILED', 'Pairing authority is no longer valid');
  }
  pairings.delete(code);
  return {
    profile: {
      name: record.profileName,
      url: record.gatewayUrl,
      authMode: 'token',
      secret: issue.secret,
    },
    expiresAt: new Date(record.expiresAtMs).toISOString(),
  };
}

export function pairingExchangePersonSession(
  code: string,
  device: PersonDeviceDescription,
  runtime: GatewayAuthRuntime,
): PersonSessionGrant {
  const record = livePairingRecord(code);
  if (
    record.authority.kind !== 'existing-principal' ||
    runtime.store.findPrincipal(record.authority.principalId)?.subject.type !== 'person'
  )
    throw new GatewayMethodError(
      'AUTH_PERSON_REQUIRED',
      'This code is for a service or node, not a person sign-in.',
    );
  let grant: PersonSessionGrant;
  try {
    grant = runtime.writer.issuePersonSession(
      record.authority.principalId,
      record.principalGeneration ?? 0,
      device,
    );
  } catch (error) {
    if (!(error instanceof CredentialStoreRefusalError)) throw error;
    pairings.delete(record.code);
    throw new GatewayMethodError('PAIRING_FAILED', 'Pairing authority is no longer valid');
  }
  pairings.delete(record.code);
  return grant;
}

function livePairingRecord(value: unknown): PairingRecord {
  if (typeof value !== 'string' || !value.trim())
    throw new GatewayMethodError('PAIRING_FAILED', 'Pairing requires a code.');
  const code = value.trim();
  const record = pairings.get(code);
  if (!record || record.expiresAtMs <= Date.now()) {
    pairings.delete(code);
    throw new GatewayMethodError('PAIRING_FAILED', 'Pairing code is invalid or expired');
  }
  return record;
}

function pruneExpiredPairings(): void {
  const now = Date.now();
  for (const [code, record] of pairings) {
    if (record.expiresAtMs <= now) pairings.delete(code);
  }
}
