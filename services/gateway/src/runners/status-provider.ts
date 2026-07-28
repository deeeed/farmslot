/**
 * Per-runner runtime status + subscription surface (ADR-023 / ADR-032).
 *
 * Callers that need runtime facts about a worker (context %, active subscription,
 * account bind for rotation) use this interface instead of branching on runner id.
 *
 * - Static launch capabilities stay on {@link RunnerDefinition} in registry.ts
 * - Tmux remains the TUI I/O channel; this provider is host/runtime facts + bind
 * - Fail-open for optional tools (CodexBar, missing statusline)
 */

import type { loadSlotVars } from '../core/config.js';

import { formatClaudeAuthLoginMethod, probeClaudeAuthStatus } from './claude-auth-status.js';
import { claudeHookObservability } from './claude-observability.js';
import { formatCodexAuthLoginMethod, probeCodexAuthStatus } from './codex-auth-status.js';
import { probeCodexBarUsageForRunner, RUNNER_TO_CODEXBAR_PROVIDER } from './codexbar-usage.js';
import { formatCursorAuthLoginMethod, probeCursorAuthStatus } from './cursor-auth-status.js';
import { formatGrokAuthLoginMethod, probeGrokAuthStatus } from './grok-auth-status.js';
import {
  hostGetActiveProfile,
  hostListEligibleLabels,
  hostResolveProviderAccount,
} from './provider-account-host.js';
import { AMBIENT_ACCOUNT_LABEL, type ResolvedProviderAccount } from './provider-accounts.js';
import { normalizeRunner } from './registry.js';

export type { ResolvedProviderAccount };

export type RunnerSubscriptionSource =
  | 'farmslot-bind'
  | 'active-profile'
  | 'ambient'
  | 'codexbar'
  | 'claude-auth'
  | 'grok-auth'
  | 'codex-auth'
  | 'cursor-auth'
  | 'unsupported'
  | 'error';

/** Active subscription for one runner on one execution host. */
export interface RunnerActiveSubscription {
  runner: string;
  /** Farmslot operator label when bind is supported; null otherwise. */
  accountLabel: string | null;
  /** Absolute auth path when bind is supported and resolved. */
  authPath?: string | null;
  /** Email / identity from CodexBar (or null when unknown). */
  accountEmail: string | null;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
  loginMethod: string | null;
  source: RunnerSubscriptionSource;
  supportsAccountBinding: boolean;
  codexBarProviderId: string | null;
  error?: string;
}

export interface ResolveAccountForSlotOptions {
  slotId: string;
  /** Forced label (failover rebind). */
  forcedLabel?: string | null;
  machineId?: string;
}

export interface AccountBindSpec {
  /** Farmslot label to stamp on the run / pass to install. */
  accountLabel: string;
  /** Absolute credential path for installers that need it (tests / overrides). */
  authPath: string | null;
  /** Launch-command option key currently used for codex home install. */
  launchAccountLabel: string | null;
}

/**
 * Generic runtime surface for a runner. Lives next to RunnerDefinition so any
 * code that needs runtime info calls a typed interface instead of switching on id.
 *
 * Adding a field: extend this interface, implement on every provider (null/false
 * defaults OK), and let callers null-check.
 */
export interface RunnerStatusProvider {
  readonly runnerId: string;

  /** Can farmslot rebind credentials for this runner (rotation)? */
  readonly supportsAccountBinding: boolean;

  /** CodexBar provider id for usage/identity mirror, or null. */
  readonly codexBarProviderId: string | null;

  /** Current context-window utilization percentage (0-100). Null when unknown. */
  getContextPct(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    target: string,
  ): Promise<number | null>;

  /**
   * Active subscription on the host that owns `vars`.
   * Fail-open — never throws for missing CodexBar / unknown identity.
   */
  getActiveSubscription(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    options?: { machineId?: string },
  ): Promise<RunnerActiveSubscription>;

  /**
   * Resolve which account a slot should launch under.
   * Throws when binding is unsupported or label is unknown (loud failure).
   */
  resolveAccountForSlot?(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    options: ResolveAccountForSlotOptions,
  ): Promise<ResolvedProviderAccount>;

  /**
   * Build launch/install bind parameters for a resolved account.
   * Used by dispatch so launch-command stays runner-agnostic for bind opts.
   */
  buildAccountBindSpec?(account: ResolvedProviderAccount): AccountBindSpec;

  /**
   * Ordered failover candidate labels for this runner on the host.
   * Empty when supportsAccountBinding is false.
   */
  listFailoverCandidates?(
    vars: Awaited<ReturnType<typeof loadSlotVars>>,
    options?: { exclude?: string[] },
  ): Promise<string[]>;
}

// ─── Shared CodexBar helper ───

async function codexBarFields(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  runner: string,
): Promise<{
  accountEmail: string | null;
  remainingPercent: number | null;
  usedPercent: number | null;
  resetsAt: string | null;
  loginMethod: string | null;
  error?: string;
}> {
  const probe = await probeCodexBarUsageForRunner({ vars, runner });
  return {
    accountEmail: probe.accountEmail,
    remainingPercent: probe.remainingPercent,
    usedPercent: probe.usedPercent,
    resetsAt: probe.resetsAt,
    loginMethod: probe.loginMethod,
    ...(probe.error ? { error: probe.error } : {}),
  };
}

// ─── Claude (ctx% + claude auth status identity + CodexBar quota; no bind) ───

const claudeStatusProvider: RunnerStatusProvider = {
  runnerId: 'claude',
  supportsAccountBinding: false,
  codexBarProviderId: RUNNER_TO_CODEXBAR_PROVIDER.claude ?? null,

  async getContextPct(vars, _target) {
    try {
      const reading = await claudeHookObservability.getContextPct(vars, _target);
      if (reading) return reading.value;
    } catch (error) {
      console.warn(
        `[runner-observability] statusline ctxPct read failed for ${vars.slotId}: ${(error as Error).message}`,
      );
    }
    return null;
  },

  async getActiveSubscription(vars) {
    // Prefer `claude auth status` for email/plan (reliable). CodexBar may add quota
    // when healthy; rate-limit / OAuth probe failures must not blank the seat.
    const [auth, usage] = await Promise.all([
      probeClaudeAuthStatus({ vars }),
      codexBarFields(vars, 'claude'),
    ]);
    const accountEmail = auth.email ?? usage.accountEmail;
    const loginMethod = formatClaudeAuthLoginMethod(auth) ?? usage.loginMethod;
    const hasIdentity = Boolean(
      accountEmail || auth.loggedIn || usage.usedPercent != null || usage.remainingPercent != null,
    );
    let source: RunnerSubscriptionSource = 'unsupported';
    if (auth.email || auth.loggedIn) source = 'claude-auth';
    else if (usage.accountEmail || usage.usedPercent != null || usage.remainingPercent != null) {
      source = 'codexbar';
    } else if (auth.error || usage.error) {
      source = 'error';
    }
    const error =
      !accountEmail && (auth.error || usage.error)
        ? [auth.error, usage.error].filter(Boolean).join('; ')
        : usage.error && accountEmail
          ? undefined // identity ok; drop quota-only noise from Setup row
          : usage.error;
    return {
      runner: 'claude',
      accountLabel: hasIdentity ? AMBIENT_ACCOUNT_LABEL : null,
      accountEmail,
      remainingPercent: usage.remainingPercent,
      usedPercent: usage.usedPercent,
      resetsAt: usage.resetsAt,
      loginMethod,
      source,
      supportsAccountBinding: false,
      codexBarProviderId: RUNNER_TO_CODEXBAR_PROVIDER.claude ?? null,
      ...(error ? { error } : {}),
    };
  },
};

// ─── Codex (bind + rotation + CodexBar) ───

const codexStatusProvider: RunnerStatusProvider = {
  runnerId: 'codex',
  supportsAccountBinding: true,
  codexBarProviderId: RUNNER_TO_CODEXBAR_PROVIDER.codex ?? null,

  async getContextPct() {
    return null;
  },

  async getActiveSubscription(vars, options) {
    const machineId = options?.machineId ?? vars.machine;
    let accountLabel: string | null = null;
    let authPath: string | null = null;
    let source: RunnerSubscriptionSource = 'ambient';
    let bindError: string | undefined;
    try {
      const active = await hostGetActiveProfile({ vars, provider: 'codex' });
      const resolved = await hostResolveProviderAccount({
        vars,
        slotId: `__machine__${machineId}`,
        provider: 'codex',
        forcedLabel: active,
      });
      accountLabel = resolved.label;
      authPath = resolved.authPath;
      source = active ? 'active-profile' : resolved.ambient ? 'ambient' : 'farmslot-bind';
    } catch (err) {
      bindError = (err as Error).message;
      source = 'error';
    }
    // CodexBar for quota/email when healthy; native auth.json / login status as identity fallback.
    const [usage, native] = await Promise.all([
      codexBarFields(vars, 'codex'),
      probeCodexAuthStatus({ vars }),
    ]);
    const accountEmail = usage.accountEmail ?? native.email;
    const loginMethod = usage.loginMethod ?? formatCodexAuthLoginMethod(native);
    // Bind source stays authoritative when we have a label; mark codex-auth only if
    // identity came solely from native probe and bind path stayed ambient.
    if (source === 'ambient' && !usage.accountEmail && (native.email || native.loggedIn)) {
      source = 'codex-auth';
    }
    const error =
      bindError ??
      (!accountEmail && usage.error && !native.email
        ? [usage.error, native.error].filter(Boolean).join('; ') || usage.error
        : usage.error && accountEmail
          ? undefined
          : !accountEmail
            ? native.error
            : undefined);
    return {
      runner: 'codex',
      accountLabel,
      authPath,
      accountEmail,
      remainingPercent: usage.remainingPercent,
      usedPercent: usage.usedPercent,
      resetsAt: usage.resetsAt,
      loginMethod,
      source,
      supportsAccountBinding: true,
      codexBarProviderId: RUNNER_TO_CODEXBAR_PROVIDER.codex ?? null,
      ...(error ? { error } : {}),
    };
  },

  async resolveAccountForSlot(vars, options) {
    return hostResolveProviderAccount({
      vars,
      slotId: options.slotId,
      provider: 'codex',
      forcedLabel: options.forcedLabel,
    });
  },

  buildAccountBindSpec(account) {
    return {
      accountLabel: account.label,
      authPath: account.authPath,
      launchAccountLabel: account.label,
    };
  },

  async listFailoverCandidates(vars, options) {
    const listed = await hostListEligibleLabels({
      vars,
      provider: 'codex',
      exclude: options?.exclude ?? [],
    });
    return listed.eligible;
  },
};

// ─── Grok (auth.json identity + CodexBar quota; no bind) ───

const grokStatusProvider: RunnerStatusProvider = {
  runnerId: 'grok',
  supportsAccountBinding: false,
  codexBarProviderId: RUNNER_TO_CODEXBAR_PROVIDER.grok ?? null,

  async getContextPct() {
    return null;
  },

  async getActiveSubscription(vars) {
    // Prefer ~/.grok/auth.json email (CLI has no auth-status JSON). CodexBar for quota.
    const [auth, usage] = await Promise.all([
      probeGrokAuthStatus({ vars }),
      codexBarFields(vars, 'grok'),
    ]);
    const accountEmail = auth.email ?? usage.accountEmail;
    const loginMethod = formatGrokAuthLoginMethod(auth) ?? usage.loginMethod;
    const hasIdentity = Boolean(
      accountEmail || auth.loggedIn || usage.usedPercent != null || usage.remainingPercent != null,
    );
    let source: RunnerSubscriptionSource = 'unsupported';
    if (auth.email || auth.loggedIn) source = 'grok-auth';
    else if (usage.accountEmail || usage.usedPercent != null || usage.remainingPercent != null) {
      source = 'codexbar';
    } else if (auth.error || usage.error) {
      source = 'error';
    }
    const error =
      !accountEmail && (auth.error || usage.error)
        ? [auth.error, usage.error].filter(Boolean).join('; ')
        : usage.error && accountEmail
          ? undefined
          : usage.error;
    return {
      runner: 'grok',
      accountLabel: hasIdentity ? AMBIENT_ACCOUNT_LABEL : null,
      accountEmail,
      remainingPercent: usage.remainingPercent,
      usedPercent: usage.usedPercent,
      resetsAt: usage.resetsAt,
      loginMethod,
      source,
      supportsAccountBinding: false,
      codexBarProviderId: RUNNER_TO_CODEXBAR_PROVIDER.grok ?? null,
      ...(error ? { error } : {}),
    };
  },
};

// ─── Cursor (cursor-agent status + CodexBar quota) ───

const cursorStatusProvider: RunnerStatusProvider = {
  runnerId: 'cursor',
  supportsAccountBinding: false,
  codexBarProviderId: RUNNER_TO_CODEXBAR_PROVIDER.cursor ?? null,

  async getContextPct() {
    return null;
  },

  async getActiveSubscription(vars) {
    const [auth, usage] = await Promise.all([
      probeCursorAuthStatus({ vars }),
      codexBarFields(vars, 'cursor'),
    ]);
    const accountEmail = auth.email ?? usage.accountEmail;
    const loginMethod = usage.loginMethod ?? formatCursorAuthLoginMethod(auth);
    const hasIdentity = Boolean(
      accountEmail || auth.loggedIn || usage.usedPercent != null || usage.remainingPercent != null,
    );
    let source: RunnerSubscriptionSource = 'unsupported';
    if (auth.email || auth.loggedIn) source = 'cursor-auth';
    else if (usage.accountEmail || usage.usedPercent != null || usage.remainingPercent != null) {
      source = 'codexbar';
    } else if (auth.error || usage.error) {
      source = 'error';
    }
    const error =
      !accountEmail && (auth.error || usage.error)
        ? [auth.error, usage.error].filter(Boolean).join('; ')
        : usage.error && accountEmail
          ? undefined
          : usage.error;
    return {
      runner: 'cursor',
      accountLabel: hasIdentity ? AMBIENT_ACCOUNT_LABEL : null,
      accountEmail,
      remainingPercent: usage.remainingPercent,
      usedPercent: usage.usedPercent,
      resetsAt: usage.resetsAt,
      loginMethod,
      source,
      supportsAccountBinding: false,
      codexBarProviderId: RUNNER_TO_CODEXBAR_PROVIDER.cursor ?? null,
      ...(error ? { error } : {}),
    };
  },
};

/**
 * Per-runner status provider registry. Runners without an entry expose no
 * runtime status surface; {@link getRunnerStatusProvider} returns null.
 */
export const KNOWN_RUNNER_STATUS_PROVIDERS: Record<string, RunnerStatusProvider> = {
  claude: claudeStatusProvider,
  codex: codexStatusProvider,
  grok: grokStatusProvider,
  cursor: cursorStatusProvider,
};

/** Runners shown on the machine Accounts panel (ordered). */
export const FLEET_SUBSCRIPTION_RUNNERS = ['codex', 'claude', 'grok', 'cursor'] as const;

export function getRunnerStatusProvider(runnerId?: string | null): RunnerStatusProvider | null {
  if (!runnerId) return null;
  const norm = normalizeRunner(runnerId);
  return KNOWN_RUNNER_STATUS_PROVIDERS[norm] ?? null;
}

/**
 * Resolve active subscriptions for the standard fleet runner set on one host.
 * Parallel, fail-open per runner — uses {@link getRunnerStatusProvider} only.
 */
export async function getHostRunnerSubscriptions(
  vars: Awaited<ReturnType<typeof loadSlotVars>>,
  options?: { machineId?: string; runners?: readonly string[] },
): Promise<RunnerActiveSubscription[]> {
  const runners = options?.runners ?? FLEET_SUBSCRIPTION_RUNNERS;
  return Promise.all(
    runners.map(async (runnerId) => {
      const provider = getRunnerStatusProvider(runnerId);
      if (!provider) {
        return {
          runner: runnerId,
          accountLabel: null,
          accountEmail: null,
          remainingPercent: null,
          usedPercent: null,
          resetsAt: null,
          loginMethod: null,
          source: 'unsupported' as const,
          supportsAccountBinding: false,
          codexBarProviderId: null,
        };
      }
      return provider.getActiveSubscription(vars, { machineId: options?.machineId });
    }),
  );
}

/**
 * Resolve account for dispatch when the runner supports binding.
 * Returns null when the runner cannot bind (caller skips rotation path).
 */
export async function resolveRunnerAccountForDispatch(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  runnerId: string;
  slotId: string;
  forcedLabel?: string | null;
}): Promise<{ account: ResolvedProviderAccount; bind: AccountBindSpec } | null> {
  const provider = getRunnerStatusProvider(options.runnerId);
  if (!provider?.supportsAccountBinding || !provider.resolveAccountForSlot) {
    return null;
  }
  const account = await provider.resolveAccountForSlot(options.vars, {
    slotId: options.slotId,
    forcedLabel: options.forcedLabel,
  });
  const bind = provider.buildAccountBindSpec?.(account) ?? {
    accountLabel: account.label,
    authPath: account.authPath,
    launchAccountLabel: account.label,
  };
  return { account, bind };
}

/**
 * Next failover label via the runner's status provider, or null if none / unsupported.
 */
export async function listRunnerFailoverCandidates(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  runnerId: string;
  exclude?: string[];
}): Promise<string[]> {
  const provider = getRunnerStatusProvider(options.runnerId);
  if (!provider?.supportsAccountBinding || !provider.listFailoverCandidates) {
    return [];
  }
  return provider.listFailoverCandidates(options.vars, { exclude: options.exclude });
}

// ─── Debug helpers (ADR-032) ───

/**
 * ADR-032 Phase 3: debug-only helper — no production caller. Claude's context-% is sourced solely
 * from the Farmslot statusline JSON via {@link claudeHookObservability}; this pane regex is retained
 * for local diagnostics only.
 */
export function parseClaudeCtxPctFromPane(pane: string): number | null {
  if (!pane) return null;
  const matches = [...pane.matchAll(/\bctx:(\d{1,3})%/gi)];
  const last = matches[matches.length - 1];
  if (last) {
    const n = parseInt(last[1], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 100) return n;
  }
  return null;
}
