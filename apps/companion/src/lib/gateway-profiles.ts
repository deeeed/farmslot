import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

import {
  type GatewayAuthConnectResult,
  type InteractiveGatewayCredentials,
  parsePersonSessionAuth,
  type PersonSessionAuth,
  PersonSessionChangedError,
  type PersonSessionStorage,
} from '@farmslot/protocol';

import type { GatewayProfileKind } from './gateway-profile-kind';
import { isLegacyPresetGatewayProfile } from './gateway-profile-legacy';
import { gatewayProfileForUrl } from './gateway-profile-selection';
import {
  isLegacyLocalhostGatewayUrl,
  isValidGatewayUrl,
  mobileGatewayProfileUrlError,
  normalizeGatewayProfileUrl,
} from './gateway-profile-validation';
import { commandCenterUrlForProfile } from './gateway-profile-web-url';

export type { GatewayProfileKind } from './gateway-profile-kind';
export type GatewayProfileAuthMode = 'none' | 'token' | 'password';

export type GatewayProfile = {
  id: string;
  name: string;
  url: string;
  commandCenterUrl?: string;
  kind: GatewayProfileKind;
  readonly?: boolean;
  authMode?: GatewayProfileAuthMode;
  secretStorageKey?: string;
  presetSecret?: string;
};

const CONFIGURED_GATEWAY_URL = Constants.expoConfig?.extra?.gatewayUrl;
const CONFIGURED_GATEWAY_AUTH_TOKEN = Constants.expoConfig?.extra?.gatewayAuthToken;
const CONFIGURED_COMMAND_CENTER_URL = Constants.expoConfig?.extra?.commandCenterUrl;
function isUsableConfiguredGatewayUrl(value: unknown): value is string {
  // Loopback URLs are valid for launcher, saved-profile, and USB adb-reverse flows.
  return typeof value === 'string' && value.length > 0 && isValidGatewayUrl(value);
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
        ...(typeof CONFIGURED_COMMAND_CENTER_URL === 'string'
          ? { commandCenterUrl: CONFIGURED_COMMAND_CENTER_URL }
          : {}),
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
  isValidGatewayUrl,
  mobileGatewayProfileUrlError,
  normalizeGatewayProfileUrl,
};

export { gatewayProfileKindUrlError, requiresSecureRemoteUrl } from './gateway-profile-kind';
export { isLegacyPresetGatewayProfile, isLegacyPresetGatewayUrl } from './gateway-profile-legacy';

export function profileSecretStorageKey(profileId: string): string {
  return `farmslot.gateway-profile.${profileId}.secret`;
}

const PROFILE_LOGIN_FORMAT = 'farmslot.profile-login.v1';
type StoredProfileLogin =
  | { kind: 'legacy'; raw: string | null }
  | { kind: 'service'; gatewayUrl: string; credential: string }
  | { kind: 'person'; gatewayUrl: string; auth: PersonSessionAuth | null };
const profileWrites = new Map<string, Promise<void>>();

async function storedLogin(profile: GatewayProfile): Promise<StoredProfileLogin> {
  const raw = await SecureStore.getItemAsync(
    profile.secretStorageKey ?? profileSecretStorageKey(profile.id),
  );
  if (!raw) return { kind: 'legacy', raw: null };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) return { kind: 'legacy', raw };
    throw error;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('format' in value) ||
    value.format !== PROFILE_LOGIN_FORMAT
  )
    return { kind: 'legacy', raw };
  if (!('gatewayUrl' in value) || value.gatewayUrl !== profile.url)
    throw new Error(
      'This saved login belongs to another gateway. Sign out there before changing its URL.',
    );
  if (
    'kind' in value &&
    value.kind === 'service' &&
    'credential' in value &&
    typeof value.credential === 'string'
  )
    return { kind: 'service', gatewayUrl: profile.url, credential: value.credential };
  if (!('kind' in value) || value.kind !== 'person' || !('auth' in value))
    throw new Error('Invalid saved login. Create a new profile to sign in.');
  const auth = value.auth === null ? null : parsePersonSessionAuth(value.auth);
  if (value.auth !== null && !auth)
    throw new Error('Invalid saved login. Create a new profile to sign in.');
  return { kind: 'person', gatewayUrl: profile.url, auth };
}

function sameLogin(left: StoredProfileLogin, right: StoredProfileLogin): boolean {
  if (left.kind === 'person' && right.kind === 'person')
    return (
      left.gatewayUrl === right.gatewayUrl && left.auth?.refreshToken === right.auth?.refreshToken
    );
  if (left.kind === 'service' && right.kind === 'service')
    return left.gatewayUrl === right.gatewayUrl && left.credential === right.credential;
  return left.kind === 'legacy' && right.kind === 'legacy' && left.raw === right.raw;
}

async function serializeProfileWrite(key: string, write: () => Promise<void>): Promise<void> {
  while (profileWrites.has(key)) await profileWrites.get(key);
  const task = write();
  profileWrites.set(key, task);
  try {
    await task;
  } finally {
    if (profileWrites.get(key) === task) profileWrites.delete(key);
  }
}

export async function readGatewayProfilePersonSession(
  profile: GatewayProfile,
): Promise<PersonSessionAuth | null> {
  const login = await storedLogin(profile);
  return login.kind === 'person' ? login.auth : null;
}

export async function readGatewayProfileSecret(profile: GatewayProfile): Promise<string | null> {
  const login = await storedLogin(profile);
  if (login.kind === 'person' || profile.authMode === 'none') return null;
  if (login.kind === 'service') return login.credential;
  const key = profile.secretStorageKey ?? profileSecretStorageKey(profile.id);
  const explicit = await SecureStore.getItemAsync(`${key}.explicit`);
  return profile.presetSecret && explicit !== 'true' ? profile.presetSecret : login.raw;
}

export interface GatewayProfileLogin {
  credentials: InteractiveGatewayCredentials & { sessionStorage: PersonSessionStorage };
  commitVerifiedCredential(result: GatewayAuthConnectResult): Promise<void>;
}

/** The stored login as saved, so a pairing that fails can put back what it replaced. */
export async function snapshotGatewayProfileLogin(profile: GatewayProfile): Promise<string | null> {
  return SecureStore.getItemAsync(profile.secretStorageKey ?? profileSecretStorageKey(profile.id));
}

export async function restoreGatewayProfileLogin(
  profile: GatewayProfile,
  snapshot: string | null,
): Promise<void> {
  const key = profile.secretStorageKey ?? profileSecretStorageKey(profile.id);
  await serializeProfileWrite(key, async () => {
    if (snapshot === null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, snapshot);
  });
}

export async function prepareGatewayProfileLogin(
  profile: GatewayProfile,
  secret?: string,
  personSession?: PersonSessionAuth,
  options: { replacePersonLogin?: boolean } = {},
): Promise<GatewayProfileLogin> {
  const key = profile.secretStorageKey ?? profileSecretStorageKey(profile.id);
  let expected = await storedLogin(profile);
  const explicit = profile.authMode !== 'none' && Boolean(secret?.trim());
  if (
    !options.replacePersonLogin &&
    (explicit || profile.authMode === 'none') &&
    expected.kind === 'person' &&
    expected.auth
  )
    throw new Error('Sign out this device before replacing its person login.');
  const raw =
    profile.authMode === 'none'
      ? null
      : explicit
        ? (secret?.trim() ?? null)
        : await readGatewayProfileSecret(profile);
  let validating = explicit || Boolean(personSession);
  let pendingPerson: PersonSessionAuth | null | undefined;
  const persistPerson = async (value: PersonSessionAuth | null) =>
    serializeProfileWrite(key, async () => {
      const current = await storedLogin(profile);
      if (!sameLogin(current, expected)) throw new PersonSessionChangedError();
      const next = { kind: 'person' as const, gatewayUrl: profile.url, auth: value };
      await SecureStore.setItemAsync(
        key,
        JSON.stringify({ format: PROFILE_LOGIN_FORMAT, ...next }),
      );
      expected = next;
    });
  const storage: PersonSessionStorage = {
    load: async () =>
      pendingPerson !== undefined
        ? pendingPerson
        : expected.kind === 'person'
          ? expected.auth
          : null,
    save: async (value) => {
      const saved = value === null ? null : parsePersonSessionAuth(value);
      if (value !== null && !saved) throw new Error('Invalid device session storage value.');
      if (validating) {
        pendingPerson = saved;
        return;
      }
      // Refusing an in-memory launcher value cannot authorize deleting another stored credential.
      if (saved === null && expected.kind === 'legacy' && expected.raw !== raw) return;
      await persistPerson(saved);
    },
  };
  return {
    credentials: {
      ...(raw && profile.authMode === 'password' ? { password: raw } : raw ? { token: raw } : {}),
      sessionStorage: storage,
      explicitPersonSignIn: explicit,
      personSessionRequired: expected.kind === 'person',
    },
    commitVerifiedCredential: async (result) => {
      if (!validating) return;
      if (pendingPerson) {
        if (
          result.principal?.subjectKind !== 'person' ||
          result.principal.id !== pendingPerson.session.principalId
        )
          throw new Error('The gateway did not verify this person sign-in.');
        await persistPerson(pendingPerson);
      } else if (explicit && result.authMode !== 'none') {
        if (result.principal?.subjectKind !== 'service' && result.principal?.subjectKind !== 'node')
          throw new Error(
            'The gateway must identify this service or node credential before it can be saved.',
          );
        await serializeProfileWrite(key, async () => {
          if (!sameLogin(await storedLogin(profile), expected))
            throw new PersonSessionChangedError();
          const next = { kind: 'service' as const, gatewayUrl: profile.url, credential: raw ?? '' };
          await SecureStore.setItemAsync(
            key,
            JSON.stringify({ format: PROFILE_LOGIN_FORMAT, ...next }),
          );
          expected = next;
        });
      }
      validating = false;
      pendingPerson = undefined;
    },
  };
}

export async function forgetGatewayProfileSecret(profile: GatewayProfile): Promise<void> {
  const key = profile.secretStorageKey ?? profileSecretStorageKey(profile.id);
  await serializeProfileWrite(key, async () => {
    const current = await storedLogin(profile);
    if (current.kind === 'person') {
      if (current.auth) throw new Error('Sign out this device before removing its person login.');
      return; // Keep the ended marker so the launcher cannot restore its old token.
    }
    await SecureStore.deleteItemAsync(`${key}.explicit`);
    await SecureStore.deleteItemAsync(key);
  });
}

export function mergeGatewayProfiles(saved: GatewayProfile[]): GatewayProfile[] {
  const byId = new Map<string, GatewayProfile>();
  for (const profile of DEFAULT_GATEWAY_PROFILES) byId.set(profile.id, profile);
  for (const profile of saved) {
    if (!profile.id || !profile.name || !isValidGatewayUrl(profile.url)) continue;
    if (isLegacyPresetGatewayProfile(profile)) continue;
    const defaultProfile = byId.get(profile.id);
    const authMode =
      profile.authMode === 'token' || profile.authMode === 'password' ? profile.authMode : 'none';
    byId.set(profile.id, {
      ...defaultProfile,
      ...profile,
      commandCenterUrl: commandCenterUrlForProfile(profile, defaultProfile),
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
  return gatewayProfileForUrl(profiles, url)?.id ?? null;
}
