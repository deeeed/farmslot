/**
 * Operator-local provider subscription accounts (Codex auth homes, etc.).
 *
 * Lives under farmslotHome() — never pool JSON / slot-config (ruling 2).
 * Missing config → every slot resolves to the ambient provider home.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

export const AMBIENT_ACCOUNT_LABEL = 'ambient';
export const DEFAULT_SESSION_COOLING_MS = 5 * 60 * 60 * 1000; // 5 hours
export const DEFAULT_EXTENDED_COOLING_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type ProviderKind = 'codex' | string;

export interface ProviderAccountDef {
  provider: ProviderKind;
  /** Absolute or ~/ path to the credential file (e.g. auth.json). */
  authPath: string;
}

export interface ProviderAccountsConfig {
  version: 1;
  accounts: Record<string, ProviderAccountDef>;
  /** slotId → account label */
  slotBindings?: Record<string, string>;
  /**
   * Default active profile per provider on this machine when no slot binding
   * and no forced label. Prefer the sibling file `active-provider-accounts.json`
   * for node-local seat switches without rewriting the account map.
   */
  activeProfiles?: Record<string, string>;
  /** Ordered failover candidates (labels). Default: all accounts for the provider. */
  failoverPool?: string[];
  cooling?: {
    sessionMs?: number;
    extendedMs?: number;
  };
  guard?: {
    enabled?: boolean;
    /** argv for subprocess, e.g. ["codexbar","guard","--provider","codex","--json","--fail-open"] */
    command?: string[];
    timeoutMs?: number;
    minRemainingPercent?: number;
  };
}

export interface ResolvedProviderAccount {
  label: string;
  provider: ProviderKind;
  authPath: string;
  ambient: boolean;
}

export function providerAccountsConfigPath(home = farmslotHome()): string {
  return path.join(home, 'provider-accounts.json');
}

export function activeProviderAccountsPath(home = farmslotHome()): string {
  return path.join(home, 'active-provider-accounts.json');
}

function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) return path.join(homedir(), p.slice(1));
  return p;
}

export function ambientCodexAuthPath(): string {
  return path.join(homedir(), '.codex', 'auth.json');
}

export function loadProviderAccountsConfig(home = farmslotHome()): ProviderAccountsConfig | null {
  const filePath = providerAccountsConfigPath(home);
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, 'utf8').trim();
  if (!raw) return null;
  const data = JSON.parse(raw) as ProviderAccountsConfig;
  if (data.version !== 1 || typeof data.accounts !== 'object' || data.accounts === null) {
    throw new Error(
      `Invalid provider-accounts.json at ${filePath}: expected version 1 with accounts map`,
    );
  }
  return data;
}

/**
 * Node-local active seat map. Prefer `active-provider-accounts.json` so a node
 * can switch seats without rewriting the full account inventory.
 */
export function loadActiveProviderProfiles(home = farmslotHome()): Record<string, string> {
  const filePath = activeProviderAccountsPath(home);
  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8').trim();
      if (raw) {
        const data = JSON.parse(raw) as { profiles?: Record<string, string> };
        if (data.profiles && typeof data.profiles === 'object') return data.profiles;
      }
    } catch {
      // Fall through to config-embedded activeProfiles.
    }
  }
  const config = loadProviderAccountsConfig(home);
  return config?.activeProfiles ?? {};
}

export function coolingDurations(config: ProviderAccountsConfig | null): {
  sessionMs: number;
  extendedMs: number;
} {
  return {
    sessionMs: config?.cooling?.sessionMs ?? DEFAULT_SESSION_COOLING_MS,
    extendedMs: config?.cooling?.extendedMs ?? DEFAULT_EXTENDED_COOLING_MS,
  };
}

/**
 * Resolve the account a slot should launch under for a provider.
 * Missing config → ambient home. Unknown binding label → throw (slot id + known labels).
 */
export function resolveProviderAccountForSlot(options: {
  slotId: string;
  provider?: ProviderKind;
  /** Forced label (failover rebind). */
  forcedLabel?: string | null;
  home?: string;
  config?: ProviderAccountsConfig | null;
}): ResolvedProviderAccount {
  const provider = options.provider ?? 'codex';
  const home = options.home ?? farmslotHome();
  const config = options.config === undefined ? loadProviderAccountsConfig(home) : options.config;

  if (!config) {
    if (options.forcedLabel && options.forcedLabel !== AMBIENT_ACCOUNT_LABEL) {
      throw new Error(
        `Provider account binding for slot '${options.slotId}' names unknown label '${options.forcedLabel}' (no provider-accounts.json; known labels: none)`,
      );
    }
    return {
      label: AMBIENT_ACCOUNT_LABEL,
      provider,
      authPath: ambientCodexAuthPath(),
      ambient: true,
    };
  }

  const knownLabels = Object.keys(config.accounts);
  const activeProfiles = loadActiveProviderProfiles(home);
  const boundLabel =
    options.forcedLabel?.trim() ||
    config.slotBindings?.[options.slotId]?.trim() ||
    activeProfiles[provider]?.trim() ||
    null;

  if (!boundLabel) {
    // Config present but no binding/active profile → ambient for that provider if defined,
    // else ambient filesystem home.
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
      };
    }
    return {
      label: AMBIENT_ACCOUNT_LABEL,
      provider,
      authPath: ambientCodexAuthPath(),
      ambient: true,
    };
  }

  const def = config.accounts[boundLabel];
  if (!def) {
    throw new Error(
      `Provider account binding for slot '${options.slotId}' names unknown label '${boundLabel}' (known labels: ${knownLabels.join(', ') || 'none'})`,
    );
  }
  if (def.provider !== provider) {
    throw new Error(
      `Provider account '${boundLabel}' is provider '${def.provider}', expected '${provider}' for slot '${options.slotId}'`,
    );
  }
  return {
    label: boundLabel,
    provider: def.provider,
    authPath: expandTilde(def.authPath),
    ambient: expandTilde(def.authPath) === ambientCodexAuthPath(),
  };
}

/** Ordered candidate labels for failover (same provider). */
export function providerFailoverCandidates(options: {
  provider?: ProviderKind;
  home?: string;
  config?: ProviderAccountsConfig | null;
  exclude?: Iterable<string>;
}): string[] {
  const provider = options.provider ?? 'codex';
  const home = options.home ?? farmslotHome();
  const config = options.config === undefined ? loadProviderAccountsConfig(home) : options.config;
  const excluded = new Set(options.exclude ?? []);

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
    if (!def) return false;
    return def.provider === provider;
  });
}

export function resolveProviderAccountByLabel(options: {
  label: string;
  slotId: string;
  provider?: ProviderKind;
  home?: string;
  config?: ProviderAccountsConfig | null;
}): ResolvedProviderAccount {
  return resolveProviderAccountForSlot({
    slotId: options.slotId,
    provider: options.provider,
    forcedLabel: options.label,
    home: options.home,
    config: options.config,
  });
}
