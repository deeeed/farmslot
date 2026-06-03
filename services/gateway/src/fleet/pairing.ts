import { randomBytes } from 'node:crypto';

import type {
  PairingCreateParams,
  PairingCreateResult,
  PairingExchangeParams,
  PairingExchangeResult,
} from '@farmslot/protocol';

import type { GatewayAuthRuntime } from '../security/auth.js';

interface PairingRecord {
  code: string;
  gatewayUrl: string;
  profileName: string;
  expiresAtMs: number;
}

const pairings = new Map<string, PairingRecord>();
const DEFAULT_TTL_SECONDS = 120;
const MAX_TTL_SECONDS = 600;

export function pairingCreate(
  params: PairingCreateParams,
  runtime: GatewayAuthRuntime,
): PairingCreateResult {
  const gatewayUrl = params.gatewayUrl.trim();
  if (!gatewayUrl.startsWith('ws://') && !gatewayUrl.startsWith('wss://')) {
    throw new Error('pairing.create requires gatewayUrl starting with ws:// or wss://');
  }
  if (runtime.auth.mode === 'none') {
    throw new Error('Pairing requires gateway token/password auth to be enabled');
  }
  if (!resolveRuntimeSecret(runtime)) {
    throw new Error('Gateway auth credential is not available for pairing');
  }

  const ttlSeconds = Math.min(
    Math.max(Number(params.ttlSeconds ?? DEFAULT_TTL_SECONDS), 30),
    MAX_TTL_SECONDS,
  );
  const code = randomBytes(24).toString('base64url');
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  const profileName = params.profileName?.trim() || 'Farmslot Remote';
  pairings.set(code, { code, gatewayUrl, profileName, expiresAtMs });
  pruneExpiredPairings();
  return {
    url: gatewayUrl,
    code,
    profileName,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function pairingExchange(
  params: PairingExchangeParams,
  runtime: GatewayAuthRuntime,
): PairingExchangeResult {
  const code = params.code.trim();
  if (!code) throw new Error('pairing.exchange requires code');
  const record = pairings.get(code);
  pairings.delete(code);
  if (!record || record.expiresAtMs <= Date.now()) {
    throw new Error('Pairing code is invalid or expired');
  }
  const secret = resolveRuntimeSecret(runtime);
  if (!secret || runtime.auth.mode === 'none') {
    throw new Error('Gateway auth credential is not available for pairing');
  }
  return {
    profile: {
      name: record.profileName,
      url: record.gatewayUrl,
      authMode: runtime.auth.mode,
      secret,
    },
    expiresAt: new Date(record.expiresAtMs).toISOString(),
  };
}

function resolveRuntimeSecret(runtime: GatewayAuthRuntime): string | null {
  if (runtime.auth.mode === 'token') return runtime.auth.token ?? null;
  if (runtime.auth.mode === 'password') return runtime.auth.password ?? null;
  return null;
}

function pruneExpiredPairings(): void {
  const now = Date.now();
  for (const [code, record] of pairings) {
    if (record.expiresAtMs <= now) pairings.delete(code);
  }
}
