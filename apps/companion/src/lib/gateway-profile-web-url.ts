import { normalizeGatewayProfileUrl } from './gateway-profile-validation';
import type { GatewayProfile } from './gateway-profiles';

/** Undefined metadata may inherit only within the same saved endpoint identity. */
export function commandCenterUrlForProfile(
  profile: GatewayProfile,
  previous?: GatewayProfile,
): string | undefined {
  if (typeof profile.commandCenterUrl === 'string') return profile.commandCenterUrl.trim();
  return previous &&
    previous.id === profile.id &&
    normalizeGatewayProfileUrl(previous.url) === normalizeGatewayProfileUrl(profile.url)
    ? previous.commandCenterUrl
    : undefined;
}
