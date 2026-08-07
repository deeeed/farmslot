import type { PairingExchangeResult } from '@farmslot/protocol';

import {
  exchangeGatewayPairingQr,
  type GatewayPairingQrPayload,
  type GatewayPairingQrProfile,
} from './gateway-pairing-exchange';
import { inferGatewayProfileKindFromUrl } from './gateway-profile-kind';
import {
  type GatewayProfile,
  isValidGatewayUrl,
  profileSecretStorageKey,
} from './gateway-profiles';

export { exchangeGatewayPairingQr };
export type { GatewayPairingQrPayload, GatewayPairingQrProfile };

export function parseGatewayPairingQr(data: string): GatewayPairingQrPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error(`Invalid pairing QR JSON: ${(error as Error).message}`);
  }

  const payload = parsed as Partial<GatewayPairingQrPayload & GatewayPairingQrProfile>;
  if (payload.type !== 'farmslot.gateway-pairing.v1') {
    throw new Error('QR code is not a Farmslot pairing payload');
  }

  const rawProfiles = Array.isArray(payload.profiles)
    ? payload.profiles
    : [
        {
          url: payload.url,
          code: payload.code,
          profileName: payload.profileName,
          expiresAt: payload.expiresAt,
        },
      ];
  const profiles = rawProfiles.map((profile, index) => normalizePairingProfile(profile, index));
  if (profiles.length === 0) {
    throw new Error('Pairing QR does not contain any profiles');
  }

  return {
    type: 'farmslot.gateway-pairing.v1',
    profiles,
  };
}

export function profileFromPairingResult(
  profile: PairingExchangeResult['profile'],
  profileId = profileIdForPairedProfile(profile),
): GatewayProfile {
  const kind = inferGatewayProfileKindFromUrl(profile.url);
  return {
    id: profileId,
    name: profile.name,
    url: profile.url,
    kind,
    authMode: profile.authMode,
    secretStorageKey: profileSecretStorageKey(profileId),
  };
}

function normalizePairingProfile(profile: unknown, index: number): GatewayPairingQrProfile {
  const candidate = profile as Partial<GatewayPairingQrProfile>;
  if (typeof candidate.url !== 'string' || !isValidGatewayUrl(candidate.url)) {
    throw new Error(`Pairing QR profile ${index + 1} has an invalid gateway URL`);
  }
  if (typeof candidate.code !== 'string' || candidate.code.trim().length === 0) {
    throw new Error(`Pairing QR profile ${index + 1} is missing its exchange code`);
  }
  return {
    url: candidate.url,
    code: candidate.code,
    ...(typeof candidate.profileName === 'string' ? { profileName: candidate.profileName } : {}),
    ...(typeof candidate.expiresAt === 'string' ? { expiresAt: candidate.expiresAt } : {}),
  };
}

function profileIdForPairedProfile(profile: PairingExchangeResult['profile']): string {
  try {
    const parsed = new URL(profile.url);
    const protocol = parsed.protocol.replace(':', '');
    return `paired-${slugForProfileId(`${protocol}-${parsed.host}${parsed.pathname}`)}`;
  } catch {
    return `paired-${slugForProfileId(`${profile.name}-${profile.url}`)}`;
  }
}

function slugForProfileId(value: string): string {
  const slug = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
  return slug || 'gateway';
}
