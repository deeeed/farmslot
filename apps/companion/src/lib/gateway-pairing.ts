import {
  exchangeGatewayPairingQr,
  type GatewayPairingQrPayload,
  type GatewayPairingQrProfile,
  type PairedGatewayProfile,
} from './gateway-pairing-exchange';
import { inferGatewayProfileKindFromUrl } from './gateway-profile-kind';
import {
  type GatewayProfile,
  isValidGatewayUrl,
  profileSecretStorageKey,
} from './gateway-profiles';

export { exchangeGatewayPairingQr };
export type { GatewayPairingQrPayload, GatewayPairingQrProfile };

// A pairing QR holds under 3 KB. A pair link has no such bound, so both are held to what a QR carries.
const MAX_PAIRING_DATA_LENGTH = 4096;
const MAX_PAIRING_PROFILES = 16;

export function parseGatewayPairingQr(data: string): GatewayPairingQrPayload {
  if (data.length > MAX_PAIRING_DATA_LENGTH) {
    throw new Error('Pairing data is larger than any Farmslot pairing QR.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error('Invalid pairing QR JSON.');
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
  if (rawProfiles.length > MAX_PAIRING_PROFILES) {
    throw new Error(
      `Pairing QR lists ${rawProfiles.length} addresses; at most ${MAX_PAIRING_PROFILES} are allowed.`,
    );
  }
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
  profile: PairedGatewayProfile,
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

/** What a pair link would do, for the user to confirm first: any app or web page can open a link. */
export function pairingLinkPrompt(
  payload: GatewayPairingQrPayload,
  savedProfiles: readonly GatewayProfile[],
): string {
  const replaced = savedProfiles.filter((saved) =>
    payload.profiles.some(
      (profile) =>
        saved.id ===
        profileIdForPairedProfile({ name: profile.profileName ?? '', url: profile.url }),
    ),
  );
  return [
    ...payload.profiles.map((profile) =>
      profile.profileName ? `${profile.profileName}: ${profile.url}` : profile.url,
    ),
    ...(replaced.length > 0
      ? [
          '',
          `Replaces the saved profile and sign-in for ${replaced.map((saved) => saved.name).join(', ')}.`,
        ]
      : []),
    '',
    'Pair only if you opened this link from your own Command Center.',
  ].join('\n');
}

export function profileIdForPairedProfile(
  profile: Pick<PairedGatewayProfile, 'name' | 'url'>,
): string {
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
