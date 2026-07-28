import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  AMBIENT_ACCOUNT_LABEL,
  ambientCodexAuthPath,
  loadProviderAccountsConfig,
  resolveProviderAccountForSlot,
} from './provider-accounts.js';

function writeConfig(home: string, body: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'provider-accounts.json'), `${JSON.stringify(body, null, 2)}\n`);
}

describe('provider-accounts resolution', () => {
  it('resolves every slot to ambient auth when no config file exists', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'provider-accounts-none-'));
    const a = resolveProviderAccountForSlot({ slotId: 'slot-a', home });
    const b = resolveProviderAccountForSlot({ slotId: 'slot-b', home });
    assert.equal(a.authPath, ambientCodexAuthPath());
    assert.equal(b.authPath, ambientCodexAuthPath());
    assert.equal(a.label, AMBIENT_ACCOUNT_LABEL);
    assert.equal(b.ambient, true);
    assert.equal(loadProviderAccountsConfig(home), null);
  });

  it('resolves two slots to different credential homes', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'provider-accounts-two-'));
    const authA = path.join(home, 'a', 'auth.json');
    const authB = path.join(home, 'b', 'auth.json');
    writeConfig(home, {
      version: 1,
      accounts: {
        'codex-a': { provider: 'codex', authPath: authA },
        'codex-b': { provider: 'codex', authPath: authB },
      },
      slotBindings: {
        'slot-1': 'codex-a',
        'slot-2': 'codex-b',
      },
    });
    const r1 = resolveProviderAccountForSlot({ slotId: 'slot-1', home });
    const r2 = resolveProviderAccountForSlot({ slotId: 'slot-2', home });
    assert.equal(r1.label, 'codex-a');
    assert.equal(r2.label, 'codex-b');
    assert.equal(r1.authPath, authA);
    assert.equal(r2.authPath, authB);
    assert.notEqual(r1.authPath, r2.authPath);
  });

  it('throws with slot id and known labels for unknown binding', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'provider-accounts-unknown-'));
    writeConfig(home, {
      version: 1,
      accounts: {
        primary: { provider: 'codex', authPath: '~/.codex/auth.json' },
      },
      slotBindings: {
        'macwork-ff-9': 'does-not-exist',
      },
    });
    assert.throws(
      () => resolveProviderAccountForSlot({ slotId: 'macwork-ff-9', home }),
      (err: Error) => {
        assert.match(err.message, /macwork-ff-9/);
        assert.match(err.message, /does-not-exist/);
        assert.match(err.message, /primary/);
        return true;
      },
    );
  });

  it('uses node active profile when no slot binding or forced label', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'provider-accounts-active-'));
    const authA = path.join(home, 'a', 'auth.json');
    const authB = path.join(home, 'b', 'auth.json');
    writeConfig(home, {
      version: 1,
      accounts: {
        'codex-a': { provider: 'codex', authPath: authA },
        'codex-b': { provider: 'codex', authPath: authB },
      },
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, 'active-provider-accounts.json'),
      JSON.stringify({ version: 1, profiles: { codex: 'codex-b' } }),
    );
    const resolved = resolveProviderAccountForSlot({ slotId: 'unbound-slot', home });
    assert.equal(resolved.label, 'codex-b');
    assert.equal(resolved.authPath, authB);
  });

  it('slot binding wins over active profile', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'provider-accounts-bind-wins-'));
    const authA = path.join(home, 'a', 'auth.json');
    const authB = path.join(home, 'b', 'auth.json');
    writeConfig(home, {
      version: 1,
      accounts: {
        'codex-a': { provider: 'codex', authPath: authA },
        'codex-b': { provider: 'codex', authPath: authB },
      },
      slotBindings: { 'slot-1': 'codex-a' },
    });
    writeFileSync(
      path.join(home, 'active-provider-accounts.json'),
      JSON.stringify({ version: 1, profiles: { codex: 'codex-b' } }),
    );
    const resolved = resolveProviderAccountForSlot({ slotId: 'slot-1', home });
    assert.equal(resolved.label, 'codex-a');
  });
});
