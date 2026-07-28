import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { nextFailoverLabel, selectEligibleProviderAccount } from './provider-account-select.js';
import { markAccountExhausted } from './usage-exhaustion-ledger.js';
import { isProviderUsageLimitError } from './usage-limit-error.js';

function writeConfig(home: string, body: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'provider-accounts.json'), JSON.stringify(body));
}

describe('provider account select + failover', () => {
  it('selects slot binding when eligible', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'select-bound-'));
    const authA = path.join(home, 'a.json');
    const authB = path.join(home, 'b.json');
    writeConfig(home, {
      version: 1,
      accounts: {
        a: { provider: 'codex', authPath: authA },
        b: { provider: 'codex', authPath: authB },
      },
      slotBindings: { 'slot-1': 'a' },
      failoverPool: ['a', 'b'],
    });
    const resolved = await selectEligibleProviderAccount({
      slotId: 'slot-1',
      home,
      spawn: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });
    assert.equal(resolved.label, 'a');
  });

  it('skips guard below-threshold without writing ledger then still can select next', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'select-guard-'));
    writeConfig(home, {
      version: 1,
      accounts: {
        a: { provider: 'codex', authPath: path.join(home, 'a.json') },
        b: { provider: 'codex', authPath: path.join(home, 'b.json') },
      },
      slotBindings: { 'slot-1': 'a' },
      failoverPool: ['a', 'b'],
      guard: {
        enabled: true,
        command: ['codexbar', 'guard', '--json'],
      },
    });
    let calls = 0;
    const resolved = await selectEligibleProviderAccount({
      slotId: 'slot-1',
      home,
      spawn: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            exitCode: 1,
            stdout: JSON.stringify({ decision: 'insufficient' }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: JSON.stringify({ decision: 'safe' }), stderr: '' };
      },
    });
    assert.equal(resolved.label, 'b');
    // Guard skip must not mark exhaustion
    const { isAccountExhausted } = await import('./usage-exhaustion-ledger.js');
    assert.equal(isAccountExhausted('a', { home }), false);
  });

  it('nextFailoverLabel returns next non-exhausted account', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'select-next-'));
    writeConfig(home, {
      version: 1,
      accounts: {
        a: { provider: 'codex', authPath: path.join(home, 'a.json') },
        b: { provider: 'codex', authPath: path.join(home, 'b.json') },
      },
      failoverPool: ['a', 'b'],
    });
    const next = nextFailoverLabel({
      slotId: 's',
      failedLabel: 'a',
      triedLabels: ['a'],
      home,
    });
    assert.equal(next?.label, 'b');
  });

  it('throws naming accounts when every candidate is exhausted', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'select-all-exhausted-'));
    writeConfig(home, {
      version: 1,
      accounts: {
        a: { provider: 'codex', authPath: path.join(home, 'a.json') },
        b: { provider: 'codex', authPath: path.join(home, 'b.json') },
      },
      slotBindings: { s: 'a' },
      failoverPool: ['a', 'b'],
    });
    markAccountExhausted({ label: 'a', home, now: () => 1000 });
    markAccountExhausted({ label: 'b', home, now: () => 1000 });
    await assert.rejects(
      () => selectEligibleProviderAccount({ slotId: 's', home, now: () => 1000 }),
      (err: unknown) => {
        assert.equal(isProviderUsageLimitError(err), true);
        if (isProviderUsageLimitError(err)) {
          assert.match(err.message, /a/);
          assert.match(err.message, /b/);
          assert.match(err.message, /Earliest cooling expiry|cooling expiry/i);
        }
        return true;
      },
    );
  });
});
