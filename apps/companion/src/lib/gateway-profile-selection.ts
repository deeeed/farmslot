import { normalizeGatewayProfileUrl } from './gateway-profile-validation';
import type { GatewayProfile } from './gateway-profiles';

export interface InitialGatewaySelection {
  url: string;
  profile: GatewayProfile | null;
}

export function gatewayProfileForUrl(
  profiles: GatewayProfile[],
  url: string,
): GatewayProfile | null {
  const normalizedUrl = normalizeGatewayProfileUrl(url);
  return (
    profiles.find((profile) => normalizeGatewayProfileUrl(profile.url) === normalizedUrl) ?? null
  );
}

export function gatewayProfileForConnection(
  profiles: GatewayProfile[],
  url: string,
  profileId: string | null,
): GatewayProfile | null {
  if (!profileId) return gatewayProfileForUrl(profiles, url);
  const profile = profiles.find((candidate) => candidate.id === profileId);
  return profile && normalizeGatewayProfileUrl(profile.url) === normalizeGatewayProfileUrl(url)
    ? profile
    : null;
}

export function selectInitialGatewayConnection(
  profiles: GatewayProfile[],
  savedUrl: string | null,
  savedActiveProfileId: string | null,
  defaultUrl: string,
): InitialGatewaySelection {
  if (savedUrl) {
    return {
      url: savedUrl,
      profile: gatewayProfileForConnection(profiles, savedUrl, savedActiveProfileId),
    };
  }

  const profile =
    profiles.find((candidate) => candidate.id === savedActiveProfileId) ?? profiles[0] ?? null;
  return {
    url: profile?.url ?? defaultUrl,
    profile,
  };
}

export function sortGatewayProfilesForAutoConnect(profiles: GatewayProfile[]): GatewayProfile[] {
  return [...profiles].sort(
    (left, right) => profileAutoConnectRank(left) - profileAutoConnectRank(right),
  );
}

function profileAutoConnectRank(profile: GatewayProfile): number {
  if (profile.kind === 'tailnet') return 0;
  if (profile.kind === 'remote') return 1;
  if (profile.kind === 'lan') return 2;
  return 3;
}
