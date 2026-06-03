// auth-store.ts — Auth profile store for LLM credentials
// Adapted from OpenClaw auth-profiles (ADR-014).
// Farmslot's own store at ~/.farmslot/auth-profiles.json.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

// ─── Types ───

export type CredentialType = 'api_key' | 'token' | 'oauth';

export interface ApiKeyCredential {
  type: 'api_key';
  provider: string;
  key: string;
}

export interface TokenCredential {
  type: 'token';
  provider: string;
  token: string;
}

export interface OAuthCredential {
  type: 'oauth';
  provider: string;
  access: string;
  refresh?: string;
  expires?: number;
  accountId?: string;
  email?: string;
}

export type AuthProfileCredential = ApiKeyCredential | TokenCredential | OAuthCredential;

export interface AuthProfileStore {
  version: number;
  profiles: Record<string, AuthProfileCredential>;
}

// ─── Paths ───

const FARMSLOT_STORE_DIR = path.join(homedir(), '.farmslot');
const FARMSLOT_STORE_PATH = path.join(FARMSLOT_STORE_DIR, 'auth-profiles.json');
const OPENCLAW_STORE_PATH = path.join(
  homedir(),
  '.openclaw',
  'agents',
  'main',
  'agent',
  'auth-profiles.json',
);

export function getFarmslotStorePath(): string {
  return FARMSLOT_STORE_PATH;
}

export function getOpenClawStorePath(): string {
  return OPENCLAW_STORE_PATH;
}

// ─── Load / Save ───

function emptyStore(): AuthProfileStore {
  return { version: 1, profiles: {} };
}

export async function loadAuthProfileStore(storePath: string): Promise<AuthProfileStore | null> {
  if (!existsSync(storePath)) return null;
  try {
    const raw = await readFile(storePath, 'utf-8');
    const data = JSON.parse(raw);
    if (data.version !== 1 || typeof data.profiles !== 'object') return null;
    return data as AuthProfileStore;
  } catch {
    return null;
  }
}

export async function saveAuthProfileStore(
  store: AuthProfileStore,
  storePath: string,
): Promise<void> {
  const dir = path.dirname(storePath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(storePath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

export async function ensureAuthStoreFile(storePath: string): Promise<AuthProfileStore> {
  const existing = await loadAuthProfileStore(storePath);
  if (existing) return existing;
  const store = emptyStore();
  await saveAuthProfileStore(store, storePath);
  return store;
}

/**
 * Serializes read-modify-write access to the farmslot auth store across
 * every write path: OAuth login completion, manual `llmAuthAdd`, import,
 * and proactive token refresh. Without this, two concurrent writers each
 * load the store, mutate their copy, and save — last writer wins, the
 * other writer's mutation is silently lost. This is especially dangerous
 * for OAuth refresh persistence: pi-ai 0.74.x rotates the refresh token,
 * so a clobbered write can lock the user out.
 *
 * Lives here (not next to a single write call site) so all callers across
 * methods/llm-auth.ts and llm/auth-refresh.ts share one mutex.
 */
let storeLockTail: Promise<unknown> = Promise.resolve();
export function withFarmslotStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = storeLockTail.then(fn, fn);
  // Re-root the tail with a swallowed-rejection adapter so an upstream
  // failure doesn't poison downstream callers; each `next` already owns
  // its own success/failure handling.
  storeLockTail = next.catch(() => undefined);
  return next;
}

// ─── Profile Operations ───

export function upsertAuthProfile(
  store: AuthProfileStore,
  profileId: string,
  credential: AuthProfileCredential,
): void {
  store.profiles[profileId] = credential;
}

export function removeAuthProfile(store: AuthProfileStore, profileId: string): boolean {
  if (profileId in store.profiles) {
    delete store.profiles[profileId];
    return true;
  }
  return false;
}

export function listProfilesForProvider(
  store: AuthProfileStore,
  provider: string,
): Array<{ profileId: string; credential: AuthProfileCredential }> {
  return Object.entries(store.profiles)
    .filter(([, cred]) => normalizeProvider(cred.provider) === provider)
    .map(([id, cred]) => ({ profileId: id, credential: cred }));
}

/**
 * Extract the raw bearer string from any credential type.
 *
 * IMPORTANT: this returns the access token as stored — for OAuth credentials
 * it does NOT consult `expires` and may hand back a token that the upstream
 * provider has already invalidated. Callers that need a guaranteed-fresh
 * token (e.g. the LLM call hot path) must run the credential through
 * {@link refreshIfExpiringSoon} from `./auth-refresh.js` first.
 *
 * Use {@link isOAuthExpired} when the consumer needs to know whether the
 * stored access token is past its expiry timestamp without performing a
 * refresh.
 */
export function extractRawAccessToken(credential: AuthProfileCredential): string | null {
  switch (credential.type) {
    case 'api_key':
      return credential.key;
    case 'token':
      return credential.token;
    case 'oauth':
      return credential.access; // JWT access token works as Bearer token
    default:
      return null;
  }
}

/**
 * Returns true if the credential is OAuth and its access token's expiry
 * timestamp is in the past. api_key/token credentials always return false
 * (no expiry info stored).
 */
export function isOAuthExpired(credential: AuthProfileCredential, now = Date.now()): boolean {
  if (credential.type !== 'oauth') return false;
  if (credential.expires === undefined) return false;
  return credential.expires <= now;
}

/** Map credential provider names to pi-ai provider names when they differ. */
const PROVIDER_ALIASES: Record<string, string> = {
  // openai-codex credentials map directly to the openai-codex pi-ai provider — no alias needed.
  // Add mappings here if a credential's provider name differs from the pi-ai provider name.
};

export function normalizeProvider(provider: string): string {
  return PROVIDER_ALIASES[provider] ?? provider;
}
