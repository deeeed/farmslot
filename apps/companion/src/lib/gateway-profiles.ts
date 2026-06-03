import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

import { isLegacyPresetGatewayProfile } from './gateway-profile-legacy';
import {
  isLegacyLocalhostGatewayUrl,
  isMobileGatewayProfileUrl,
  isValidGatewayUrl,
  mobileGatewayProfileUrlError,
} from './gateway-profile-validation';

export type GatewayProfileKind = 'lan' | 'custom' | 'remote' | 'tailnet';
export type GatewayProfileAuthMode = 'none' | 'token' | 'password';

export type GatewayProfile = {
  id: string;
  name: string;
  url: string;
  kind: GatewayProfileKind;
  readonly?: boolean;
  authMode?: GatewayProfileAuthMode;
  secretStorageKey?: string;
  presetSecret?: string;
};

const CONFIGURED_GATEWAY_URL = Constants.expoConfig?.extra?.gatewayUrl;
const CONFIGURED_GATEWAY_AUTH_TOKEN = Constants.expoConfig?.extra?.gatewayAuthToken;
function isUsableConfiguredGatewayUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isMobileGatewayProfileUrl(value);
}

export const DEFAULT_GATEWAY_URL = isUsableConfiguredGatewayUrl(CONFIGURED_GATEWAY_URL)
  ? CONFIGURED_GATEWAY_URL
  : '';

const DEFAULT_PROFILE_SECRET =
  typeof CONFIGURED_GATEWAY_AUTH_TOKEN === 'string' && CONFIGURED_GATEWAY_AUTH_TOKEN.trim()
    ? CONFIGURED_GATEWAY_AUTH_TOKEN.trim()
    : undefined;

export const DEFAULT_GATEWAY_PROFILES: GatewayProfile[] = DEFAULT_GATEWAY_URL
  ? [
      {
        id: 'configured-gateway',
        name: 'Configured Gateway',
        url: DEFAULT_GATEWAY_URL,
        kind: DEFAULT_GATEWAY_URL.startsWith('wss://') ? 'remote' : 'custom',
        readonly: true,
        authMode: DEFAULT_PROFILE_SECRET ? 'token' : 'none',
        ...(DEFAULT_PROFILE_SECRET
          ? {
              secretStorageKey: profileSecretStorageKey('configured-gateway'),
              presetSecret: DEFAULT_PROFILE_SECRET,
            }
          : {}),
      },
    ]
  : [];

export {
  isLegacyLocalhostGatewayUrl,
  isMobileGatewayProfileUrl,
  isValidGatewayUrl,
  mobileGatewayProfileUrlError,
};

export function requiresSecureRemoteUrl(profile: Pick<GatewayProfile, 'kind' | 'url'>): boolean {
  return (
    (profile.kind === 'remote' || profile.kind === 'tailnet') && !profile.url.startsWith('wss://')
  );
}

export { isLegacyPresetGatewayProfile, isLegacyPresetGatewayUrl } from './gateway-profile-legacy';

export function profileSecretStorageKey(profileId: string): string {
  return `farmslot.gateway-profile.${profileId}.secret`;
}

export async function readGatewayProfileSecret(profile: GatewayProfile): Promise<string | null> {
  if (!profile.secretStorageKey || profile.authMode === 'none') return null;
  return SecureStore.getItemAsync(profile.secretStorageKey);
}

export async function writeGatewayProfileSecret(
  profile: GatewayProfile,
  secret: string,
): Promise<void> {
  const key = profile.secretStorageKey ?? profileSecretStorageKey(profile.id);
  if (!secret.trim()) {
    await SecureStore.deleteItemAsync(key);
    return;
  }
  await SecureStore.setItemAsync(key, secret.trim());
}

export async function seedPresetGatewayProfileSecrets(profiles: GatewayProfile[]): Promise<void> {
  for (const profile of profiles) {
    if (
      !profile.presetSecret ||
      !profile.secretStorageKey ||
      profile.authMode === 'none' ||
      !profile.presetSecret.trim()
    ) {
      continue;
    }
    const existing = await SecureStore.getItemAsync(profile.secretStorageKey);
    if (existing !== profile.presetSecret.trim()) {
      await SecureStore.setItemAsync(profile.secretStorageKey, profile.presetSecret.trim());
    }
  }
}

export function mergeGatewayProfiles(saved: GatewayProfile[]): GatewayProfile[] {
  const byId = new Map<string, GatewayProfile>();
  for (const profile of DEFAULT_GATEWAY_PROFILES) byId.set(profile.id, profile);
  for (const profile of saved) {
    if (!profile.id || !profile.name || !isMobileGatewayProfileUrl(profile.url)) continue;
    if (isLegacyPresetGatewayProfile(profile)) continue;
    if (profile.id === 'localhost' || isLegacyLocalhostGatewayUrl(profile.url)) continue;
    const defaultProfile = byId.get(profile.id);
    const authMode =
      profile.authMode === 'token' || profile.authMode === 'password' ? profile.authMode : 'none';
    byId.set(profile.id, {
      ...defaultProfile,
      ...profile,
      kind:
        profile.kind === 'remote' || profile.kind === 'tailnet'
          ? profile.kind
          : profile.kind === 'lan'
            ? profile.kind
            : 'custom',
      authMode,
      secretStorageKey: authMode === 'none' ? undefined : profileSecretStorageKey(profile.id),
      ...(defaultProfile?.presetSecret ? { presetSecret: defaultProfile.presetSecret } : {}),
      readonly: profile.readonly && byId.has(profile.id),
    });
  }
  return [...byId.values()];
}

export function profileIdForUrl(profiles: GatewayProfile[], url: string): string | null {
  return profiles.find((profile) => profile.url === url)?.id ?? null;
}
