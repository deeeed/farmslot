import type { GatewayProfile } from './gateway-profiles';

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
