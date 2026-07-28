/**
 * Persisted provider usage exhaustion ledger — survives gateway restarts.
 * Session tier (default 5h) escalates to extended (default 7d) on immediate re-exhaustion.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import {
  coolingDurations,
  loadProviderAccountsConfig,
  type ProviderAccountsConfig,
} from './provider-accounts.js';

export type ExhaustionTier = 'session' | 'extended';

export interface ExhaustionEntry {
  label: string;
  provider: string;
  tier: ExhaustionTier;
  exhaustedAt: string;
  expiresAt: string;
  /** True after a successful run since last exhaustion. */
  hadSuccessSinceExhaustion?: boolean;
}

export interface ExhaustionLedgerFile {
  version: 1;
  entries: Record<string, ExhaustionEntry>;
}

export type Clock = () => number;

export function exhaustionLedgerPath(home = farmslotHome()): string {
  return path.join(home, 'provider-usage-exhaustion.json');
}

export function loadExhaustionLedger(home = farmslotHome()): ExhaustionLedgerFile {
  const filePath = exhaustionLedgerPath(home);
  if (!existsSync(filePath)) return { version: 1, entries: {} };
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (!raw) return { version: 1, entries: {} };
    const data = JSON.parse(raw) as ExhaustionLedgerFile;
    if (data.version !== 1 || typeof data.entries !== 'object' || !data.entries) {
      return { version: 1, entries: {} };
    }
    return data;
  } catch {
    // Corrupt ledger must not brick dispatch — start empty and let the next write repair it.
    return { version: 1, entries: {} };
  }
}

export function saveExhaustionLedger(ledger: ExhaustionLedgerFile, home = farmslotHome()): void {
  const filePath = exhaustionLedgerPath(home);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

export function isAccountExhausted(
  label: string,
  options: { home?: string; now?: Clock; ledger?: ExhaustionLedgerFile } = {},
): boolean {
  const now = options.now ?? Date.now;
  const ledger = options.ledger ?? loadExhaustionLedger(options.home);
  const entry = ledger.entries[label];
  if (!entry) return false;
  return Date.parse(entry.expiresAt) > now();
}

export function earliestExhaustionExpiry(
  labels: string[],
  options: { home?: string; ledger?: ExhaustionLedgerFile } = {},
): string | null {
  const ledger = options.ledger ?? loadExhaustionLedger(options.home);
  let earliest: number | null = null;
  let earliestIso: string | null = null;
  for (const label of labels) {
    const entry = ledger.entries[label];
    if (!entry) continue;
    const t = Date.parse(entry.expiresAt);
    if (Number.isNaN(t)) continue;
    if (earliest === null || t < earliest) {
      earliest = t;
      earliestIso = entry.expiresAt;
    }
  }
  return earliestIso;
}

/**
 * Mark an account exhausted. First hit → session tier; re-exhaustion on the first
 * dispatch after expiry with no intervening success → extended tier.
 */
export function markAccountExhausted(options: {
  label: string;
  provider?: string;
  home?: string;
  now?: Clock;
  config?: ProviderAccountsConfig | null;
  ledger?: ExhaustionLedgerFile;
}): ExhaustionEntry {
  const home = options.home ?? farmslotHome();
  const nowMs = (options.now ?? Date.now)();
  const config = options.config === undefined ? loadProviderAccountsConfig(home) : options.config;
  const { sessionMs, extendedMs } = coolingDurations(config);
  const ledger = options.ledger ?? loadExhaustionLedger(home);
  const prev = ledger.entries[options.label];

  let tier: ExhaustionTier = 'session';
  if (prev) {
    const prevExpiry = Date.parse(prev.expiresAt);
    const expired = !Number.isNaN(prevExpiry) && prevExpiry <= nowMs;
    if (expired && !prev.hadSuccessSinceExhaustion) {
      tier = 'extended';
    } else if (!expired) {
      // Still cooling — keep / bump tier if already extended
      tier = prev.tier === 'extended' ? 'extended' : 'session';
    }
  }

  const duration = tier === 'extended' ? extendedMs : sessionMs;
  const entry: ExhaustionEntry = {
    label: options.label,
    provider: options.provider ?? 'codex',
    tier,
    exhaustedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + duration).toISOString(),
    hadSuccessSinceExhaustion: false,
  };
  ledger.entries[options.label] = entry;
  saveExhaustionLedger(ledger, home);
  return entry;
}

/** Successful run resets tier tracking for that label. */
export function recordAccountSuccess(options: {
  label: string;
  home?: string;
  now?: Clock;
  ledger?: ExhaustionLedgerFile;
}): void {
  const home = options.home ?? farmslotHome();
  const ledger = options.ledger ?? loadExhaustionLedger(home);
  const prev = ledger.entries[options.label];
  if (!prev) return;
  // Drop active cooling on success so the account is immediately eligible again,
  // and record success so a later exhaustion does not escalate spuriously.
  delete ledger.entries[options.label];
  saveExhaustionLedger(ledger, home);
}

export function filterEligibleLabels(
  labels: string[],
  options: { home?: string; now?: Clock; ledger?: ExhaustionLedgerFile } = {},
): string[] {
  return labels.filter((label) => !isAccountExhausted(label, options));
}
