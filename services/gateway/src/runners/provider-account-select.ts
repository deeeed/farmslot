/**
 * Select an eligible provider account for dispatch, applying optional guard skip
 * and exhaustion ledger (without writing ledger on guard below-threshold).
 */

import {
  AMBIENT_ACCOUNT_LABEL,
  loadProviderAccountsConfig,
  type ProviderAccountsConfig,
  providerFailoverCandidates,
  type ResolvedProviderAccount,
  resolveProviderAccountByLabel,
  resolveProviderAccountForSlot,
} from './provider-accounts.js';
import { consultQuotaGuard, type GuardSpawnFn } from './quota-guard.js';
import {
  type Clock,
  earliestExhaustionExpiry,
  filterEligibleLabels,
  isAccountExhausted,
  loadExhaustionLedger,
} from './usage-exhaustion-ledger.js';
import { createNoEligibleProviderAccountError } from './usage-limit-error.js';

export async function selectEligibleProviderAccount(options: {
  slotId: string;
  provider?: string;
  /** Prefer this label first (slot binding or forced). */
  preferredLabel?: string | null;
  /** Labels already tried this run — excluded. */
  exclude?: string[];
  home?: string;
  config?: ProviderAccountsConfig | null;
  now?: Clock;
  spawn?: GuardSpawnFn;
}): Promise<ResolvedProviderAccount> {
  const provider = options.provider ?? 'codex';
  const home = options.home;
  const config = options.config === undefined ? loadProviderAccountsConfig(home) : options.config;
  const exclude = new Set(options.exclude ?? []);
  const ledger = loadExhaustionLedger(home);

  const preferred =
    options.preferredLabel?.trim() ||
    resolveProviderAccountForSlot({
      slotId: options.slotId,
      provider,
      home,
      config,
    }).label;

  const ordered = [
    preferred,
    ...providerFailoverCandidates({ provider, home, config }).filter((l) => l !== preferred),
  ].filter((l) => !exclude.has(l));

  const eligible = filterEligibleLabels(ordered, {
    home,
    now: options.now,
    ledger,
  });

  if (!eligible.length) {
    throw createNoEligibleProviderAccountError({
      triedLabels: ordered.length ? ordered : [preferred],
      earliestExpiry: earliestExhaustionExpiry(ordered, { home, ledger }),
      provider,
    });
  }

  for (const label of eligible) {
    // Guard is advisory: below-threshold skips without ledger write.
    const guard = await consultQuotaGuard({
      provider,
      accountLabel: label,
      config,
      home,
      spawn: options.spawn,
    });
    if (guard.verdict === 'below-threshold') {
      console.log(
        `[dispatch] quota guard skipped account '${label}' for slot ${options.slotId} (below-threshold)`,
      );
      continue;
    }
    return resolveProviderAccountByLabel({
      label,
      slotId: options.slotId,
      provider,
      home,
      config,
    });
  }

  // All eligible were guard-skipped — fall back to first eligible (reactive path remains correctness).
  // Spec: guard must not fail dispatch; if every candidate is below-threshold, still try first eligible.
  return resolveProviderAccountByLabel({
    label: eligible[0]!,
    slotId: options.slotId,
    provider,
    home,
    config,
  });
}

export function nextFailoverLabel(options: {
  slotId: string;
  provider?: string;
  failedLabel: string;
  triedLabels: string[];
  home?: string;
  config?: ProviderAccountsConfig | null;
  now?: Clock;
}): ResolvedProviderAccount | null {
  const provider = options.provider ?? 'codex';
  const config =
    options.config === undefined ? loadProviderAccountsConfig(options.home) : options.config;
  const exclude = new Set(options.triedLabels);
  exclude.add(options.failedLabel);

  const candidates = providerFailoverCandidates({
    provider,
    home: options.home,
    config,
    exclude,
  }).filter((label) => !isAccountExhausted(label, { home: options.home, now: options.now }));

  if (!candidates.length) return null;

  try {
    return resolveProviderAccountByLabel({
      label: candidates[0]!,
      slotId: options.slotId,
      provider,
      home: options.home,
      config,
    });
  } catch {
    return null;
  }
}

export { AMBIENT_ACCOUNT_LABEL };
