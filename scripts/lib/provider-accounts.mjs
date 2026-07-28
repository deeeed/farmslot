/**
 * Node-local provider subscription accounts (paths + ledger + active profile).
 * Used by the observability installer and provider-account-cli on the execution host.
 * Paths expand against THIS machine's home — never the gateway's.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const AMBIENT_ACCOUNT_LABEL = 'ambient';
export const DEFAULT_SESSION_COOLING_MS = 5 * 60 * 60 * 1000;
export const DEFAULT_EXTENDED_COOLING_MS = 7 * 24 * 60 * 60 * 1000;

export function expandTilde(p) {
  if (p === '~' || (typeof p === 'string' && p.startsWith('~/'))) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

export function farmslotHomeFromEnv(env = process.env) {
  const fromEnv = env.FARMSLOT_HOME?.trim();
  if (fromEnv) return expandTilde(fromEnv);
  return path.join(os.homedir(), '.farmslot');
}

export function providerAccountsConfigPath(home = farmslotHomeFromEnv()) {
  return path.join(home, 'provider-accounts.json');
}

export function activeProviderAccountsPath(home = farmslotHomeFromEnv()) {
  return path.join(home, 'active-provider-accounts.json');
}

export function exhaustionLedgerPath(home = farmslotHomeFromEnv()) {
  return path.join(home, 'provider-usage-exhaustion.json');
}

export function ambientCodexAuthPath() {
  return path.join(os.homedir(), '.codex', 'auth.json');
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

export function loadProviderAccountsConfig(home = farmslotHomeFromEnv()) {
  const filePath = providerAccountsConfigPath(home);
  const data = readJsonIfExists(filePath);
  if (!data) return null;
  if (data.version !== 1 || typeof data.accounts !== 'object' || data.accounts === null) {
    throw new Error(
      `Invalid provider-accounts.json at ${filePath}: expected version 1 with accounts map`,
    );
  }
  return data;
}

/** { version: 1, profiles: { codex: "label" } } — node-local active seat without editing account map. */
export function loadActiveProviderProfiles(home = farmslotHomeFromEnv()) {
  const fromFile = readJsonIfExists(activeProviderAccountsPath(home));
  if (fromFile?.profiles && typeof fromFile.profiles === 'object') {
    return fromFile.profiles;
  }
  const config = loadProviderAccountsConfig(home);
  if (config?.activeProfiles && typeof config.activeProfiles === 'object') {
    return config.activeProfiles;
  }
  return {};
}

export function saveActiveProviderProfile(provider, label, home = farmslotHomeFromEnv()) {
  const filePath = activeProviderAccountsPath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = readJsonIfExists(filePath) || { version: 1, profiles: {} };
  const profiles = {
    ...(existing.profiles && typeof existing.profiles === 'object' ? existing.profiles : {}),
    [provider]: label,
  };
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`, 'utf8');
  return profiles;
}

export function coolingDurations(config) {
  return {
    sessionMs: config?.cooling?.sessionMs ?? DEFAULT_SESSION_COOLING_MS,
    extendedMs: config?.cooling?.extendedMs ?? DEFAULT_EXTENDED_COOLING_MS,
  };
}

/**
 * Resolve order:
 * 1. forcedLabel
 * 2. slotBindings[slotId]
 * 3. activeProfiles[provider] (file or config)
 * 4. ambient
 */
export function resolveProviderAccountForSlot({
  slotId,
  provider = 'codex',
  forcedLabel = null,
  home = farmslotHomeFromEnv(),
  config: configIn,
} = {}) {
  const config = configIn === undefined ? loadProviderAccountsConfig(home) : configIn;
  const active = loadActiveProviderProfiles(home);

  if (!config) {
    if (forcedLabel && forcedLabel !== AMBIENT_ACCOUNT_LABEL) {
      throw new Error(
        `Provider account binding for slot '${slotId}' names unknown label '${forcedLabel}' (no provider-accounts.json; known labels: none)`,
      );
    }
    return {
      label: AMBIENT_ACCOUNT_LABEL,
      provider,
      authPath: ambientCodexAuthPath(),
      ambient: true,
      source: 'ambient-no-config',
    };
  }

  const knownLabels = Object.keys(config.accounts);
  const boundLabel =
    (forcedLabel && String(forcedLabel).trim()) ||
    config.slotBindings?.[slotId]?.trim() ||
    active[provider]?.trim() ||
    null;

  if (!boundLabel) {
    const ambientDef = Object.entries(config.accounts).find(
      ([, def]) =>
        def.provider === provider && expandTilde(def.authPath) === ambientCodexAuthPath(),
    );
    if (ambientDef) {
      return {
        label: ambientDef[0],
        provider,
        authPath: expandTilde(ambientDef[1].authPath),
        ambient: true,
        source: 'ambient-matching-account',
      };
    }
    return {
      label: AMBIENT_ACCOUNT_LABEL,
      provider,
      authPath: ambientCodexAuthPath(),
      ambient: true,
      source: 'ambient-default',
    };
  }

  const def = config.accounts[boundLabel];
  if (!def) {
    throw new Error(
      `Provider account binding for slot '${slotId}' names unknown label '${boundLabel}' (known labels: ${knownLabels.join(', ') || 'none'})`,
    );
  }
  if (def.provider !== provider) {
    throw new Error(
      `Provider account '${boundLabel}' is provider '${def.provider}', expected '${provider}' for slot '${slotId}'`,
    );
  }
  const authPath = expandTilde(def.authPath);
  return {
    label: boundLabel,
    provider: def.provider,
    authPath,
    ambient: authPath === ambientCodexAuthPath(),
    source: forcedLabel
      ? 'forced-label'
      : config.slotBindings?.[slotId]
        ? 'slot-binding'
        : active[provider]
          ? 'active-profile'
          : 'unknown',
  };
}

export function providerFailoverCandidates({
  provider = 'codex',
  home = farmslotHomeFromEnv(),
  config: configIn,
  exclude = [],
} = {}) {
  const config = configIn === undefined ? loadProviderAccountsConfig(home) : configIn;
  const excluded = new Set(exclude);
  if (!config) {
    return excluded.has(AMBIENT_ACCOUNT_LABEL) ? [] : [AMBIENT_ACCOUNT_LABEL];
  }
  const pool =
    config.failoverPool ??
    Object.entries(config.accounts)
      .filter(([, def]) => def.provider === provider)
      .map(([label]) => label);
  return pool.filter((label) => {
    if (excluded.has(label)) return false;
    const def = config.accounts[label];
    return Boolean(def && def.provider === provider);
  });
}

export function loadExhaustionLedger(home = farmslotHomeFromEnv()) {
  const filePath = exhaustionLedgerPath(home);
  try {
    const data = readJsonIfExists(filePath);
    if (!data || data.version !== 1 || typeof data.entries !== 'object' || !data.entries) {
      return { version: 1, entries: {} };
    }
    return data;
  } catch {
    return { version: 1, entries: {} };
  }
}

export function saveExhaustionLedger(ledger, home = farmslotHomeFromEnv()) {
  const filePath = exhaustionLedgerPath(home);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

export function isAccountExhausted(
  label,
  { home = farmslotHomeFromEnv(), now = Date.now, ledger } = {},
) {
  const book = ledger ?? loadExhaustionLedger(home);
  const entry = book.entries[label];
  if (!entry) return false;
  return Date.parse(entry.expiresAt) > now();
}

export function earliestExhaustionExpiry(labels, { home = farmslotHomeFromEnv(), ledger } = {}) {
  const book = ledger ?? loadExhaustionLedger(home);
  let earliest = null;
  let earliestIso = null;
  for (const label of labels) {
    const entry = book.entries[label];
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

export function markAccountExhausted({
  label,
  provider = 'codex',
  home = farmslotHomeFromEnv(),
  now = Date.now,
  config: configIn,
  ledger: ledgerIn,
} = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const config = configIn === undefined ? loadProviderAccountsConfig(home) : configIn;
  const { sessionMs, extendedMs } = coolingDurations(config);
  const ledger = ledgerIn ?? loadExhaustionLedger(home);
  const prev = ledger.entries[label];
  let tier = 'session';
  if (prev) {
    const prevExpiry = Date.parse(prev.expiresAt);
    const expired = !Number.isNaN(prevExpiry) && prevExpiry <= nowMs;
    if (expired && !prev.hadSuccessSinceExhaustion) {
      tier = 'extended';
    } else if (!expired && prev.tier === 'extended') {
      tier = 'extended';
    }
  }
  const duration = tier === 'extended' ? extendedMs : sessionMs;
  const entry = {
    label,
    provider,
    tier,
    exhaustedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + duration).toISOString(),
    hadSuccessSinceExhaustion: false,
  };
  ledger.entries[label] = entry;
  saveExhaustionLedger(ledger, home);
  return entry;
}

export function recordAccountSuccess({ label, home = farmslotHomeFromEnv() } = {}) {
  const ledger = loadExhaustionLedger(home);
  if (!ledger.entries[label]) return;
  delete ledger.entries[label];
  saveExhaustionLedger(ledger, home);
}

export function filterEligibleLabels(labels, opts = {}) {
  return labels.filter((label) => !isAccountExhausted(label, opts));
}

export function listEligibleLabels({
  provider = 'codex',
  home = farmslotHomeFromEnv(),
  exclude = [],
  now = Date.now,
} = {}) {
  const candidates = providerFailoverCandidates({ provider, home, exclude });
  return filterEligibleLabels(candidates, { home, now });
}
