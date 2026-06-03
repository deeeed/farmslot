// auth-refresh.ts — silent OAuth token refresh for stored credentials.
//
// Used in two places:
//   1. resolveAuth() preempts expiry on hot-path LLM calls.
//   2. The llm.auth.refresh gateway method exposes a manual trigger to the UI.
//
// Refresh failures are non-fatal in the hot path — if the refresh token has
// also expired we surface the existing access token; the LLM call will then
// fail with a clear error from the wrapper, which is the user's signal to
// re-login.

import { refreshOpenAICodexToken } from '@earendil-works/pi-ai/oauth';

import {
  type AuthProfileCredential,
  getFarmslotStorePath,
  loadAuthProfileStore,
  type OAuthCredential,
  saveAuthProfileStore,
  upsertAuthProfile,
  withFarmslotStoreLock,
} from './auth-store.js';

/** Refresh tokens whose access token expires within this many ms get rotated proactively. */
export const PROACTIVE_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export interface RefreshOutcome {
  ok: boolean;
  profileId: string;
  expiresBefore: number | undefined;
  expiresAfter?: number;
  error?: string;
}

/** Predicate: returns true if the credential should be refreshed proactively. */
export function shouldProactivelyRefresh(cred: AuthProfileCredential, now = Date.now()): boolean {
  if (cred.type !== 'oauth') return false;
  if (!cred.refresh) return false;
  if (cred.expires === undefined) return false;
  return cred.expires - now <= PROACTIVE_REFRESH_WINDOW_MS;
}

/** Refresh a single OAuth credential. Returns the rotated credential. */
export async function refreshOAuthCredential(cred: OAuthCredential): Promise<OAuthCredential> {
  if (cred.provider !== 'openai-codex') {
    throw new Error(`refresh not implemented for provider ${cred.provider}`);
  }
  if (!cred.refresh) {
    throw new Error('credential has no refresh token — re-login required');
  }
  const next = await refreshOpenAICodexToken(cred.refresh);
  return {
    type: 'oauth',
    provider: cred.provider,
    access: next.access,
    refresh: next.refresh ?? cred.refresh,
    expires: next.expires,
    accountId: cred.accountId,
    email: cred.email,
  };
}

/**
 * Refresh every farmslot-stored profile that matches `filter`. Stores are
 * loaded, mutated in place, and saved once at the end. Returns per-profile
 * outcomes so callers can report partial successes to the UI.
 */
export async function refreshFarmslotProfiles(
  filter?: (profileId: string, cred: AuthProfileCredential) => boolean,
): Promise<RefreshOutcome[]> {
  const storePath = getFarmslotStorePath();
  const snapshot = await loadAuthProfileStore(storePath);
  if (!snapshot) return [];

  // Phase 1: do the slow refresh round-trips OUTSIDE the store lock so we
  // don't block other writers (login / import / manual add) for the
  // duration of N network calls. The credential snapshot here is just for
  // selecting which profiles to refresh; the persist phase re-reads.
  const outcomes: RefreshOutcome[] = [];
  const updates = new Map<string, OAuthCredential>();
  for (const [profileId, cred] of Object.entries(snapshot.profiles)) {
    if (cred.type !== 'oauth') continue;
    if (filter && !filter(profileId, cred)) continue;
    if (!cred.refresh) {
      outcomes.push({
        ok: false,
        profileId,
        expiresBefore: cred.expires,
        error: 'no refresh token (re-login required)',
      });
      continue;
    }
    try {
      const updated = await refreshOAuthCredential(cred);
      updates.set(profileId, updated);
      outcomes.push({
        ok: true,
        profileId,
        expiresBefore: cred.expires,
        expiresAfter: updated.expires,
      });
    } catch (err) {
      outcomes.push({
        ok: false,
        profileId,
        expiresBefore: cred.expires,
        error: (err as Error).message,
      });
    }
  }

  if (updates.size === 0) return outcomes;

  // Phase 2: re-load + apply all updates + save under the shared mutex so
  // a concurrent login/import/manual-add can't race-clobber our writes.
  // We additionally compare the locked store's credential to the snapshot
  // we refreshed against — if a concurrent writer has already replaced the
  // profile (different access token, or the entry no longer exists) the
  // refresh result is stale and gets dropped to avoid overwriting a newer
  // credential.
  await withFarmslotStoreLock(async () => {
    const store = await loadAuthProfileStore(storePath);
    if (!store) return;
    for (const [profileId, updated] of updates) {
      const snapshotCred = snapshot.profiles[profileId];
      const currentCred = store.profiles[profileId];
      if (!isSameStoredCredential(snapshotCred, currentCred)) {
        const idx = outcomes.findIndex((o) => o.profileId === profileId && o.ok);
        if (idx >= 0) {
          outcomes[idx] = {
            ok: false,
            profileId,
            expiresBefore: outcomes[idx].expiresBefore,
            error: 'skipped — profile was updated by another writer mid-refresh',
          };
        }
        console.log(
          `[auth-refresh] skipped persisting refresh for ${profileId}: profile changed in store mid-refresh`,
        );
        continue;
      }
      upsertAuthProfile(store, profileId, updated);
    }
    await saveAuthProfileStore(store, storePath);
  });

  return outcomes;
}

/**
 * Identity check used by the refresh persist phase: did the credential we
 * started from match what's currently in the store? OAuth refreshes rotate
 * `access` (and sometimes `refresh`), so a mismatch on either field means
 * a concurrent writer has already replaced this profile and our refresh
 * result is stale.
 */
function isSameStoredCredential(
  a: AuthProfileCredential | undefined,
  b: AuthProfileCredential | undefined,
): boolean {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === 'oauth' && b.type === 'oauth') {
    return a.access === b.access && a.refresh === b.refresh;
  }
  if (a.type === 'api_key' && b.type === 'api_key') return a.key === b.key;
  if (a.type === 'token' && b.type === 'token') return a.token === b.token;
  return false;
}

/**
 * In-flight refresh promises keyed by profileId. pi-ai 0.74.x rotates the
 * refresh token on each successful refresh — the previous refresh token is
 * invalidated. Without coalescing, two concurrent resolveAuth callers within
 * the proactive window each call refreshOpenAICodexToken; the second one
 * sends a now-invalidated refresh token and fails, and both race-write the
 * store, potentially clobbering the actual current refresh token.
 */
const inflightRefreshes = new Map<string, Promise<AuthProfileCredential>>();

/**
 * Hot-path helper: if the credential is expiring soon and lives in the
 * farmslot store, rotate it. Returns the credential to use (refreshed or
 * original). On refresh failure returns the original — caller should still
 * attempt the request so the wrapper can surface a clear "expired" error.
 *
 * Concurrent calls for the same profileId share a single in-flight promise;
 * see comment on `inflightRefreshes` above.
 */
export async function refreshIfExpiringSoon(
  profileId: string,
  cred: AuthProfileCredential,
): Promise<AuthProfileCredential> {
  if (!shouldProactivelyRefresh(cred)) return cred;
  const existing = inflightRefreshes.get(profileId);
  if (existing) return existing;
  const promise = doRefreshAndPersist(profileId, cred).finally(() => {
    inflightRefreshes.delete(profileId);
  });
  inflightRefreshes.set(profileId, promise);
  return promise;
}

async function doRefreshAndPersist(
  profileId: string,
  cred: AuthProfileCredential,
): Promise<AuthProfileCredential> {
  try {
    const updated = await refreshOAuthCredential(cred as OAuthCredential);
    // Persist through the shared store lock. Another writer (OAuth login,
    // import, manual add) may have mutated the store between our
    // refreshOAuthCredential call and now; the lock ensures we read the
    // freshest copy, apply only our profile mutation, and save without
    // clobbering their unrelated changes.
    let staleSkipped = false;
    await withFarmslotStoreLock(async () => {
      const storePath = getFarmslotStorePath();
      const store = await loadAuthProfileStore(storePath);
      if (!store) return;
      const currentCred = store.profiles[profileId];
      if (!isSameStoredCredential(cred, currentCred)) {
        // A concurrent login/manual-add/import already replaced this
        // profile; their newer credential wins. Don't write the rotated
        // refresh token back over it.
        staleSkipped = true;
        return;
      }
      upsertAuthProfile(store, profileId, updated);
      await saveAuthProfileStore(store, storePath);
    });
    if (staleSkipped) {
      console.log(
        `[auth-refresh] skipped persisting refresh for ${profileId}: profile changed in store mid-refresh`,
      );
      return cred;
    }
    console.log(
      `[auth-refresh] rotated ${profileId} (expires=${new Date(updated.expires ?? 0).toISOString()})`,
    );
    return updated;
  } catch (err) {
    console.warn(
      `[auth-refresh] proactive refresh failed for ${profileId}: ${(err as Error).message}`,
    );
    return cred;
  }
}
