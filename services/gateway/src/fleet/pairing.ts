import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname, networkInterfaces } from 'node:os';

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
} from '@farmslot/protocol';

import type { GatewayAuthRuntime } from '../security/auth.js';

interface PairingRecord {
  code: string;
  gatewayUrl: string;
  profileName: string;
  expiresAtMs: number;
  authority: PairingAuthority;
}

const pairings = new Map<string, PairingRecord>();
const DEFAULT_TTL_SECONDS = 120;
const MAX_TTL_SECONDS = 600;

export function pairingCandidates(params: PairingCandidatesParams = {}): PairingCandidatesResult {
  const port = Number(params.port || process.env.GATEWAY_PORT || 7777);
  return { candidates: reachablePairingCandidates(Number.isFinite(port) ? port : 7777) };
}

export function reachablePairingCandidates(port: number): PairingCandidate[] {
  const host = hostname().replace(/\.local$/, '');
  const candidates: PairingCandidate[] = lanIPv4s().map((ip) => ({
    gatewayUrl: `ws://${ip}:${port}/ws`,
    profileName: `${host} (LAN)`,
    kind: 'lan',
  }));
  const tailnet = tailscaleDnsName();
  if (tailnet) {
    candidates.push({
      gatewayUrl: `ws://${tailnet}:${port}/ws`,
      profileName: `${host} (Tailscale)`,
      kind: 'tailnet',
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

function lanIPv4s(): string[] {
  const all: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) all.push(iface.address);
    }
  }
  const isPrivate = (ip: string): boolean =>
    /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  const priv = all.filter(isPrivate);
  return [...new Set(priv.length > 0 ? priv : all)];
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
  if (params.authority.kind === 'existing-principal') {
    if (typeof params.authority.principalId !== 'string' || !params.authority.principalId) {
      throw new Error('existing-principal authority requires principalId');
    }
    const principal = runtime.store.findPrincipal(params.authority.principalId);
    if (!principal) {
      throw new Error(`Pairing principal '${params.authority.principalId}' does not exist`);
    }
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
  if (typeof params?.code !== 'string') throw new Error('pairing.exchange requires code');
  const code = params.code.trim();
  if (!code) throw new Error('pairing.exchange requires code');
  const record = pairings.get(code);
  pairings.delete(code);
  if (!record || record.expiresAtMs <= Date.now()) {
    throw new Error('Pairing code is invalid or expired');
  }
  const principalId =
    record.authority.kind === 'existing-principal'
      ? record.authority.principalId
      : runtime.writer.createPrincipal(
          { type: 'service', displayName: record.authority.displayName },
          record.authority.roles,
        ).id;
  const issue = runtime.writer.issueCredential(principalId, record.profileName, 'paired');
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

function pruneExpiredPairings(): void {
  const now = Date.now();
  for (const [code, record] of pairings) {
    if (record.expiresAtMs <= now) pairings.delete(code);
  }
}
