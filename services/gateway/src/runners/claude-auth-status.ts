/**
 * Fail-open Claude Code identity probe via `claude auth status --json`.
 * Complements CodexBar (which is often rate-limited / incomplete for Claude).
 * Never tokens or credential paths — email + plan only.
 */

import { spawn } from 'node:child_process';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  email: string | null;
  /** e.g. max, pro, team — maps to loginMethod in the UI. */
  subscriptionType: string | null;
  authMethod: string | null;
  orgName: string | null;
  error?: string;
}

const EMPTY: ClaudeAuthStatus = {
  loggedIn: false,
  email: null,
  subscriptionType: null,
  authMethod: null,
  orgName: null,
};

/** Parse `claude auth status --json` stdout (tokens never present). */
export function parseClaudeAuthStatusJson(stdout: string): ClaudeAuthStatus {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ...EMPTY, error: 'empty-output' };
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf('{');
    if (start < 0) return { ...EMPTY, error: 'unparseable' };
    try {
      data = JSON.parse(trimmed.slice(start));
    } catch {
      return { ...EMPTY, error: 'unparseable' };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ...EMPTY, error: 'empty-row' };
  }
  const row = data as Record<string, unknown>;
  const email = typeof row.email === 'string' && row.email.trim() ? row.email.trim() : null;
  const subscriptionType =
    typeof row.subscriptionType === 'string' && row.subscriptionType.trim()
      ? row.subscriptionType.trim()
      : null;
  const authMethod =
    typeof row.authMethod === 'string' && row.authMethod.trim() ? row.authMethod.trim() : null;
  const orgName = typeof row.orgName === 'string' && row.orgName.trim() ? row.orgName.trim() : null;
  const loggedIn = row.loggedIn === true || Boolean(email);

  return {
    loggedIn,
    email,
    subscriptionType,
    authMethod,
    orgName,
  };
}

/** Human plan line for Setup UI — e.g. "max · claude.ai". */
export function formatClaudeAuthLoginMethod(status: ClaudeAuthStatus): string | null {
  const parts: string[] = [];
  if (status.subscriptionType) parts.push(status.subscriptionType);
  if (status.authMethod) parts.push(status.authMethod);
  return parts.length ? parts.join(' · ') : null;
}

function spawnClaudeAuthLocal(
  claudeBin: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    // stdin ignore: `claude auth status` can block reading a non-TTY stdin.
    const child = spawn(claudeBin, ['auth', 'status', '--json'], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number | null, errMsg?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr || errMsg || '',
        exitCode,
      });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null, 'timeout');
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(null, code === 'ENOENT' ? 'claude not found' : err.message);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}

/**
 * Probe Claude auth on the slot host. Fail-open — never throws for missing CLI / not logged in.
 */
export async function probeClaudeAuthStatus(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  timeoutMs?: number;
}): Promise<ClaudeAuthStatus> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const claudeBin = options.vars.claudePath?.trim() || 'claude';

  try {
    if (isLocal(options.vars.host, options.vars.machine)) {
      const result = await spawnClaudeAuthLocal(claudeBin, timeoutMs);
      if (!result.stdout.trim()) {
        return {
          ...EMPTY,
          error: result.stderr || (result.exitCode === null ? 'spawn-failed' : 'empty-output'),
        };
      }
      return parseClaudeAuthStatusJson(result.stdout);
    }

    const binExpr = claudeBin === 'claude' ? 'claude' : shellExpressionForRemotePath(claudeBin);
    // stdin from /dev/null so remote claude doesn't hang.
    const cmd = `${binExpr} auth status --json </dev/null`;
    const result = await execOnSlot(options.vars, cmd, { timeout: timeoutMs });
    if (!result.stdout.trim()) {
      return {
        ...EMPTY,
        error:
          result.stderr?.trim() ||
          (result.exitCode !== 0 ? `exit ${result.exitCode}` : 'empty-output'),
      };
    }
    return parseClaudeAuthStatusJson(result.stdout);
  } catch (err) {
    return {
      ...EMPTY,
      error: (err as Error).message || 'probe-failed',
    };
  }
}
