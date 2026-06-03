import type { GatewayProfile } from './gateway-profiles';

export function sanitizeGatewayProfilesForStorage(profiles: GatewayProfile[]): GatewayProfile[] {
  return profiles.map(({ presetSecret: _presetSecret, ...profile }) => profile);
}

export function parseGatewayProfilesFromStorage(raw: string | null): GatewayProfile[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as GatewayProfile[]) : [];
  } catch {
    // Malformed AsyncStorage should not block Companion boot; defaults are
    // re-merged and can be saved again through the normal settings flow.
    return [];
  }
}
