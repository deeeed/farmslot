#!/usr/bin/env -S npx tsx
// refresh-codex-auth.ts — silently refresh the access token on every
// openai-codex OAuth profile in <FARMSLOT_HOME>/auth-profiles.json (default ~/.farmslot) using the
// stored refresh token. No browser flow, no manual paste. Exits non-zero
// if any profile is missing a refresh token or if pi-ai rejects it.
//
// Usage:
//   cd services/gateway
//   npx tsx scripts/refresh-codex-auth.ts

import { refreshOpenAICodexToken } from '@earendil-works/pi-ai/oauth';

import {
  getFarmslotStorePath,
  loadAuthProfileStore,
  type OAuthCredential,
  saveAuthProfileStore,
  upsertAuthProfile,
} from '../src/llm/auth-store.js';

function fmtExpires(ms: number | undefined): string {
  if (!ms) return 'never';
  return new Date(ms).toISOString();
}

async function main() {
  const storePath = getFarmslotStorePath();
  const store = await loadAuthProfileStore(storePath);
  if (!store) {
    console.error(`no farmslot auth store at ${storePath}`);
    process.exit(1);
  }

  const targets = Object.entries(store.profiles).filter(
    ([, c]) => c.type === 'oauth' && c.provider === 'openai-codex',
  ) as Array<[string, OAuthCredential]>;

  if (targets.length === 0) {
    console.error('no openai-codex OAuth profiles found');
    process.exit(1);
  }

  let refreshed = 0;
  let failed = 0;
  for (const [profileId, cred] of targets) {
    if (!cred.refresh) {
      console.warn(`skip ${profileId}: no refresh token (re-login required)`);
      failed += 1;
      continue;
    }
    console.log(`refreshing ${profileId} (was: expires=${fmtExpires(cred.expires)})...`);
    try {
      const next = await refreshOpenAICodexToken(cred.refresh);
      const updated: OAuthCredential = {
        type: 'oauth',
        provider: 'openai-codex',
        access: next.access,
        refresh: next.refresh ?? cred.refresh,
        expires: next.expires,
        accountId: cred.accountId,
        email: cred.email,
      };
      upsertAuthProfile(store, profileId, updated);
      console.log(`  → expires=${fmtExpires(updated.expires)}`);
      refreshed += 1;
    } catch (err) {
      console.error(`  ✗ failed: ${(err as Error).message}`);
      failed += 1;
    }
  }

  if (refreshed > 0) {
    await saveAuthProfileStore(store, storePath);
    console.log(`saved ${refreshed} refreshed profile(s) to ${storePath}`);
  }
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(`refresh-codex-auth: ${(err as Error).message}`);
  process.exit(1);
});
