/**
 * Fail-open CodexBar usage probe — mirrors provider identity/quota for fleet UI.
 * Never writes the exhaustion ledger; never blocks dispatch.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

const execFileAsync = promisify(execFile);

/** CodexBar provider ids for farmslot runners. */
export const RUNNER_TO_CODEXBAR_PROVIDER: Record<string, string> = {
  codex: 'codex',
  claude: 'claude',
  grok: 'grok',
  cursor: 'cursor',
};

export interface CodexBarUsageIdentity {
  provider: string;
  accountEmail: string | null;
  /** 0–100 remaining if known; null when unavailable. */
  remainingPercent: number | null;
  /** 0–100 used on primary window when remaining unknown. */
  usedPercent: number | null;
  resetsAt: string | null;
  loginMethod: string | null;
  source: string | null;
  error?: string;
}

function firstObject(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
    return data[0] as Record<string, unknown>;
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/** Parse `codexbar usage --format json` stdout for one provider. */
export function parseCodexBarUsageJson(stdout: string, provider: string): CodexBarUsageIdentity {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      provider,
      accountEmail: null,
      remainingPercent: null,
      usedPercent: null,
      resetsAt: null,
      loginMethod: null,
      source: null,
      error: 'empty-output',
    };
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // Sometimes logs precede JSON — take last array/object slice.
    const start = Math.max(trimmed.lastIndexOf('['), trimmed.lastIndexOf('{'));
    if (start < 0) {
      return {
        provider,
        accountEmail: null,
        remainingPercent: null,
        usedPercent: null,
        resetsAt: null,
        loginMethod: null,
        source: null,
        error: 'unparseable',
      };
    }
    try {
      data = JSON.parse(trimmed.slice(start));
    } catch {
      return {
        provider,
        accountEmail: null,
        remainingPercent: null,
        usedPercent: null,
        resetsAt: null,
        loginMethod: null,
        source: null,
        error: 'unparseable',
      };
    }
  }

  const row = firstObject(data);
  if (!row) {
    return {
      provider,
      accountEmail: null,
      remainingPercent: null,
      usedPercent: null,
      resetsAt: null,
      loginMethod: null,
      source: null,
      error: 'empty-row',
    };
  }

  // CodexBar sometimes returns { provider, error: { message } } with no usage block
  // (e.g. Claude OAuth not found). Surface that without inventing identity.
  const errObj =
    row.error && typeof row.error === 'object' ? (row.error as Record<string, unknown>) : null;
  if (errObj && !row.usage) {
    return {
      provider: typeof row.provider === 'string' ? row.provider : provider,
      accountEmail: null,
      remainingPercent: null,
      usedPercent: null,
      resetsAt: null,
      loginMethod: null,
      source: typeof row.source === 'string' ? row.source : null,
      error: typeof errObj.message === 'string' ? errObj.message : 'provider-error',
    };
  }

  const usage =
    row.usage && typeof row.usage === 'object' ? (row.usage as Record<string, unknown>) : row;
  const identity =
    usage.identity && typeof usage.identity === 'object'
      ? (usage.identity as Record<string, unknown>)
      : null;
  const primary =
    usage.primary && typeof usage.primary === 'object'
      ? (usage.primary as Record<string, unknown>)
      : null;
  const secondary =
    usage.secondary && typeof usage.secondary === 'object'
      ? (usage.secondary as Record<string, unknown>)
      : null;
  const window = primary ?? secondary;

  const accountEmail =
    (typeof usage.accountEmail === 'string' && usage.accountEmail) ||
    (typeof identity?.accountEmail === 'string' && identity.accountEmail) ||
    (typeof identity?.email === 'string' && identity.email) ||
    null;

  const usedPercent = numOrNull(window?.usedPercent);
  // Prefer remaining when present; else derive from used.
  let remainingPercent = numOrNull(window?.remainingPercent);
  if (remainingPercent == null && usedPercent != null) {
    remainingPercent = Math.max(0, Math.min(100, 100 - usedPercent));
  }

  const resetsAt =
    (typeof window?.resetsAt === 'string' && window.resetsAt) ||
    (typeof window?.resetAt === 'string' && window.resetAt) ||
    null;

  const loginMethod =
    (typeof usage.loginMethod === 'string' && usage.loginMethod) ||
    (typeof identity?.loginMethod === 'string' && identity.loginMethod) ||
    null;

  return {
    provider: typeof row.provider === 'string' ? row.provider : provider,
    accountEmail,
    remainingPercent,
    usedPercent,
    resetsAt,
    loginMethod,
    source: typeof row.source === 'string' ? row.source : null,
  };
}

async function spawnCodexBarLocal(
  provider: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      'codexbar',
      ['usage', '--provider', provider, '--format', 'json'],
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
      },
    );
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as {
      code?: string;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (e.code === 'ENOENT') {
      return { stdout: '', stderr: 'codexbar not found', exitCode: null };
    }
    // execFile throws on non-zero; still may have stdout
    return {
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? e.message ?? ''),
      exitCode: e.killed ? null : 1,
    };
  }
}

/**
 * Probe CodexBar for a runner on the slot's execution host. Fail-open always.
 */
export async function probeCodexBarUsageForRunner(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  runner: string;
  timeoutMs?: number;
}): Promise<CodexBarUsageIdentity> {
  const provider = RUNNER_TO_CODEXBAR_PROVIDER[options.runner];
  if (!provider) {
    return {
      provider: options.runner,
      accountEmail: null,
      remainingPercent: null,
      usedPercent: null,
      resetsAt: null,
      loginMethod: null,
      source: null,
      error: 'no-codexbar-provider',
    };
  }
  const timeoutMs = options.timeoutMs ?? 12_000;

  try {
    if (isLocal(options.vars.host, options.vars.machine)) {
      const result = await spawnCodexBarLocal(provider, timeoutMs);
      if (result.exitCode === null && !result.stdout.trim()) {
        return {
          provider,
          accountEmail: null,
          remainingPercent: null,
          usedPercent: null,
          resetsAt: null,
          loginMethod: null,
          source: null,
          error: result.stderr || 'spawn-failed',
        };
      }
      return parseCodexBarUsageJson(result.stdout, provider);
    }

    const cmd = `codexbar usage --provider ${shellQuote(provider)} --format json`;
    const result = await execOnSlot(options.vars, cmd, { timeout: timeoutMs });
    if (result.exitCode !== 0 && !result.stdout.trim()) {
      return {
        provider,
        accountEmail: null,
        remainingPercent: null,
        usedPercent: null,
        resetsAt: null,
        loginMethod: null,
        source: null,
        error: result.stderr || `exit-${result.exitCode}`,
      };
    }
    return parseCodexBarUsageJson(result.stdout, provider);
  } catch (err) {
    return {
      provider,
      accountEmail: null,
      remainingPercent: null,
      usedPercent: null,
      resetsAt: null,
      loginMethod: null,
      source: null,
      error: (err as Error).message,
    };
  }
}
