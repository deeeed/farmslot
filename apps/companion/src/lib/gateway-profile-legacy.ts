const LEGACY_PRESET_PROFILE_IDS = new Set(['macwork-lan', 'farmslot-remote']);

export function isLegacyPresetGatewayProfile(profile: Pick<{ id: string }, 'id'>): boolean {
  // Legacy cleanup is keyed by the old baked-in profile IDs only. The same URLs
  // (for example ws://runner.local:7777/ws) are valid user-created or QR-paired
  // profiles and must not be filtered out after AsyncStorage persistence.
  return LEGACY_PRESET_PROFILE_IDS.has(profile.id);
}

export function isLegacyPresetGatewayUrl(_url: string | null | undefined): boolean {
  // Kept for saved active-url migration callers. Do not classify URLs as legacy:
  // URL-based filtering made fresh QR-paired profiles disappear on re-read.
  return false;
}
