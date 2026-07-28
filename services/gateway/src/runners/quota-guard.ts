/**
 * Optional advisory quota preflight (CodexBar guard, etc.).
 * Off by default; fail-open on any uncertainty. Never writes the exhaustion ledger.
 */

import { spawn } from 'node:child_process';

import { loadProviderAccountsConfig, type ProviderAccountsConfig } from './provider-accounts.js';

export type GuardVerdict = 'ok' | 'below-threshold' | 'unknown';

export interface GuardResult {
  verdict: GuardVerdict;
  raw?: string;
  reason?: string;
}

export type GuardSpawnFn = (options: {
  command: string[];
  timeoutMs: number;
}) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export async function defaultGuardSpawn(options: {
  command: string[];
  timeoutMs: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  if (!options.command.length) {
    return { exitCode: null, stdout: '', stderr: 'empty command' };
  }
  const [bin, ...args] = options.command;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, options.timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

function parseGuardJson(stdout: string): GuardVerdict {
  const trimmed = stdout.trim();
  if (!trimmed) return 'unknown';
  try {
    const data = JSON.parse(trimmed) as {
      decision?: string;
      exitCode?: number;
    };
    const decision = String(data.decision ?? '').toLowerCase();
    if (decision === 'safe' || decision === 'ok' || decision === 'pass') return 'ok';
    if (
      decision === 'insufficient' ||
      decision === 'below-threshold' ||
      decision === 'block' ||
      decision === 'deny'
    ) {
      return 'below-threshold';
    }
    if (decision === 'unknown') return 'unknown';
    // Fall through to exitCode if present in JSON
    if (typeof data.exitCode === 'number') {
      if (data.exitCode === 0) return 'ok';
      if (data.exitCode === 1) return 'below-threshold';
      return 'unknown';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Consult the optional guard. Disabled / missing / errors → verdict unknown (caller treats as pass).
 * below-threshold must NOT write the exhaustion ledger.
 */
export async function consultQuotaGuard(options: {
  provider?: string;
  accountLabel?: string;
  config?: ProviderAccountsConfig | null;
  home?: string;
  spawn?: GuardSpawnFn;
}): Promise<GuardResult> {
  const config =
    options.config === undefined ? loadProviderAccountsConfig(options.home) : options.config;
  const guard = config?.guard;
  if (!guard?.enabled) {
    return { verdict: 'unknown', reason: 'guard-disabled' };
  }
  if (!guard.command?.length) {
    return { verdict: 'unknown', reason: 'guard-no-command' };
  }

  const timeoutMs = guard.timeoutMs ?? 5_000;
  const command = [...guard.command];
  // Best-effort inject account label if the template uses a placeholder.
  const argv = command.map((part) =>
    part
      .replaceAll('{{account}}', options.accountLabel ?? '')
      .replaceAll('{{provider}}', options.provider ?? 'codex'),
  );

  try {
    const spawnFn = options.spawn ?? defaultGuardSpawn;
    const result = await spawnFn({ command: argv, timeoutMs });
    if (result.exitCode === null) {
      return { verdict: 'unknown', reason: 'guard-timeout-or-spawn-error', raw: result.stderr };
    }
    // Prefer JSON decision when present
    if (result.stdout.trim().startsWith('{') || result.stdout.trim().startsWith('[')) {
      const fromJson = parseGuardJson(result.stdout);
      if (fromJson !== 'unknown') {
        return { verdict: fromJson, raw: result.stdout };
      }
      // unknown decision with exit 0 → treat as ok only if JSON said something parseable as ok path
      if (fromJson === 'unknown' && result.exitCode === 0) {
        // codexbar: exit 0 with decision unknown is fail-open — do not block
        return { verdict: 'unknown', raw: result.stdout, reason: 'guard-unknown-decision' };
      }
    }
    if (result.exitCode === 0) return { verdict: 'ok', raw: result.stdout };
    if (result.exitCode === 1) return { verdict: 'below-threshold', raw: result.stdout };
    return {
      verdict: 'unknown',
      raw: result.stdout || result.stderr,
      reason: `guard-exit-${result.exitCode}`,
    };
  } catch (err) {
    return {
      verdict: 'unknown',
      reason: `guard-exception:${(err as Error).message}`,
    };
  }
}
