import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_EXTENDED_COOLING_MS, DEFAULT_SESSION_COOLING_MS } from './provider-accounts.js';
import {
  isAccountExhausted,
  loadExhaustionLedger,
  markAccountExhausted,
  recordAccountSuccess,
} from './usage-exhaustion-ledger.js';

describe('usage exhaustion ledger', () => {
  it('writes session-tier entry and survives reload (restart)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'exhaustion-session-'));
    let now = 1_000_000;
    const entry = markAccountExhausted({
      label: 'codex-a',
      home,
      now: () => now,
    });
    assert.equal(entry.tier, 'session');
    assert.equal(Date.parse(entry.expiresAt), now + DEFAULT_SESSION_COOLING_MS);

    const reloaded = loadExhaustionLedger(home);
    assert.equal(reloaded.entries['codex-a']?.tier, 'session');
    assert.equal(isAccountExhausted('codex-a', { home, now: () => now }), true);

    // After expiry, selectable again with no manual clearing.
    now = Date.parse(entry.expiresAt) + 1;
    assert.equal(isAccountExhausted('codex-a', { home, now: () => now }), false);
  });

  it('escalates to extended on re-exhaustion after expiry without success', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'exhaustion-escalated-'));
    let now = 2_000_000;
    const first = markAccountExhausted({ label: 'codex-a', home, now: () => now });
    assert.equal(first.tier, 'session');

    now = Date.parse(first.expiresAt) + 1;
    const second = markAccountExhausted({ label: 'codex-a', home, now: () => now });
    assert.equal(second.tier, 'extended');
    assert.equal(Date.parse(second.expiresAt), now + DEFAULT_EXTENDED_COOLING_MS);
  });

  it('successful run clears exhaustion (tier reset)', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'exhaustion-success-'));
    const now = 3_000_000;
    markAccountExhausted({ label: 'codex-a', home, now: () => now });
    recordAccountSuccess({ label: 'codex-a', home, now: () => now });
    assert.equal(isAccountExhausted('codex-a', { home, now: () => now }), false);
    assert.equal(loadExhaustionLedger(home).entries['codex-a'], undefined);

    // Next exhaustion is session again (not extended).
    const again = markAccountExhausted({ label: 'codex-a', home, now: () => now + 10 });
    assert.equal(again.tier, 'session');
  });

  it('persists ledger file under farmslot home', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'exhaustion-file-'));
    markAccountExhausted({ label: 'x', home, now: () => 10 });
    const raw = readFileSync(path.join(home, 'provider-usage-exhaustion.json'), 'utf8');
    assert.match(raw, /"version": 1/);
    assert.match(raw, /"x"/);
  });
});
