import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Methods } from '@farmslot/protocol';

import {
  loadActiveProviderProfiles,
  resolveProviderAccountForSlot,
} from '../runners/provider-accounts.js';

describe('provider accounts protocol surface', () => {
  it('registers providerAccounts.snapshot method name', () => {
    assert.equal(Methods.PROVIDER_ACCOUNTS_SNAPSHOT, 'providerAccounts.snapshot');
  });

  it('active profile drives machine-default resolve without slot binding', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'pa-ui-'));
    const auth = path.join(home, 'auth.json');
    mkdirSync(home, { recursive: true });
    writeFileSync(auth, '{}');
    writeFileSync(
      path.join(home, 'provider-accounts.json'),
      JSON.stringify({
        version: 1,
        accounts: { 'seat-ui': { provider: 'codex', authPath: auth } },
      }),
    );
    writeFileSync(
      path.join(home, 'active-provider-accounts.json'),
      JSON.stringify({ version: 1, profiles: { codex: 'seat-ui' } }),
    );
    const profiles = loadActiveProviderProfiles(home);
    assert.equal(profiles.codex, 'seat-ui');
    const resolved = resolveProviderAccountForSlot({
      slotId: '__machine__macwork',
      home,
      forcedLabel: profiles.codex,
    });
    assert.equal(resolved.label, 'seat-ui');
    assert.equal(resolved.ambient, false);
  });
});
