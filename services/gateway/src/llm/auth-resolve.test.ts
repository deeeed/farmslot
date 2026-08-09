import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveAuth } from './auth-resolve.js';
import { ensureOAuthCredentialSeeded, piCredentialStore } from './index.js';

// The main regression class of MANUAL-000101: an oauth credential resolved
// from the FARMSLOT STORE (which outranks ~/.codex/auth.json in the cascade)
// must carry the oauth bundle, and the bundle must actually land in pi-ai's
// credential store — otherwise oauth-only providers fail pre-transport with
// "Provider is not configured" despite valid auth.
test('farmslot-store oauth profile flows through resolveAuth into pi-ai seeding', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'farmslot-auth-resolve-'));
  mkdirSync(home, { recursive: true });
  // Far-future expiry so refreshIfExpiringSoon leaves the credential alone.
  const expires = Date.now() + 7 * 24 * 60 * 60 * 1000;
  writeFileSync(
    join(home, 'auth-profiles.json'),
    JSON.stringify({
      version: 1,
      profiles: {
        'openai-codex:test': {
          type: 'oauth',
          provider: 'openai-codex',
          access: 'store-access-token-value-long-enough-to-be-plausible',
          refresh: 'store-refresh-token',
          expires,
        },
      },
    }),
  );
  const previousHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    await piCredentialStore.delete('openai-codex');
    rmSync(home, { recursive: true, force: true });
  });

  const auth = await resolveAuth('openai-codex');

  assert.ok(auth, 'store profile must resolve');
  assert.equal(auth.source, 'farmslot:openai-codex:test');
  assert.deepEqual(auth.oauth, {
    access: 'store-access-token-value-long-enough-to-be-plausible',
    refresh: 'store-refresh-token',
    expires,
  });

  // The same bundle must seed pi-ai's store — the exact call path
  // callLLM/callLLMChat run before completeSimple/streamSimple.
  await ensureOAuthCredentialSeeded('openai-codex', auth.oauth);
  assert.deepEqual(await piCredentialStore.read('openai-codex'), {
    type: 'oauth',
    access: 'store-access-token-value-long-enough-to-be-plausible',
    refresh: 'store-refresh-token',
    expires,
  });
});

test('api-key store profiles resolve without an oauth bundle', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'farmslot-auth-resolve-key-'));
  writeFileSync(
    join(home, 'auth-profiles.json'),
    JSON.stringify({
      version: 1,
      profiles: {
        'anthropic:test': { type: 'api_key', provider: 'anthropic', key: 'sk-test-key' },
      },
    }),
  );
  const previousHome = process.env.FARMSLOT_HOME;
  process.env.FARMSLOT_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.FARMSLOT_HOME;
    else process.env.FARMSLOT_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const auth = await resolveAuth('anthropic');

  assert.ok(auth);
  assert.equal(auth.apiKey, 'sk-test-key');
  assert.equal(auth.oauth, undefined);
});
