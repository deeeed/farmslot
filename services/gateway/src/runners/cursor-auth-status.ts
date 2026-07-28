/**
 * Fail-open Cursor identity via `cursor-agent status --format json` (or whoami).
 * Never returns tokens — email + name only.
 */

import { spawn } from 'node:child_process';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';

export interface CursorAuthStatus {
  loggedIn: boolean;
  email: string | null;
  displayName: string | null;
  error?: string;
}

const EMPTY: CursorAuthStatus = {
  loggedIn: false,
  email: null,
  displayName: null,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Parse `cursor-agent status --format json` / whoami JSON. */
export function parseCursorAuthStatusJson(stdout: string): CursorAuthStatus {
  const trimmed = stdout.trim();
  if (!trimmed) return { ...EMPTY, error: 'empty-output' };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf('{');
    if (start < 0) return parseCursorAuthStatusText(trimmed);
    try {
      data = JSON.parse(trimmed.slice(start));
    } catch {
      return parseCursorAuthStatusText(trimmed);
    }
  }
  if (!isRecord(data)) return { ...EMPTY, error: 'empty-row' };

  const userInfo = isRecord(data.userInfo) ? data.userInfo : data;
  const email =
    (typeof userInfo.email === 'string' && userInfo.email.includes('@') && userInfo.email.trim()) ||
    (typeof data.email === 'string' && data.email.includes('@') && data.email.trim()) ||
    null;
  const first = typeof userInfo.firstName === 'string' ? userInfo.firstName.trim() : '';
  const last = typeof userInfo.lastName === 'string' ? userInfo.lastName.trim() : '';
  const displayName =
    [first, last].filter(Boolean).join(' ') ||
    (typeof userInfo.name === 'string' ? userInfo.name.trim() : null) ||
    null;
  const loggedIn =
    data.isAuthenticated === true || data.status === 'authenticated' || Boolean(email);

  if (!loggedIn && !email) {
    return { ...EMPTY, error: 'not-logged-in' };
  }
  return { loggedIn: true, email, displayName: displayName || null };
}

/** Parse text: "✓ Logged in as arthur.breton@consensys.net" */
export function parseCursorAuthStatusText(stdout: string): CursorAuthStatus {
  const text = stdout.trim();
  if (!text) return { ...EMPTY, error: 'empty-output' };
  if (/not logged in|logged out|unauthenticated/i.test(text)) {
    return { ...EMPTY, error: 'not-logged-in' };
  }
  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (/logged in/i.test(text) || emailMatch) {
    return {
      loggedIn: true,
      email: emailMatch?.[0] ?? null,
      displayName: null,
    };
  }
  return { ...EMPTY, error: 'unparseable' };
}

export function formatCursorAuthLoginMethod(status: CursorAuthStatus): string | null {
  return status.loggedIn || status.email ? 'cursor' : null;
}

function spawnCursorStatus(
  cursorBin: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cursorBin, ['status', '--format', 'json'], {
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
      resolve({ stdout, stderr: stderr || errMsg || '', exitCode });
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null, 'timeout');
    }, timeoutMs);
    child.stdout?.on('data', (c: Buffer | string) => {
      stdout += String(c);
    });
    child.stderr?.on('data', (c: Buffer | string) => {
      stderr += String(c);
    });
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      finish(null, code === 'ENOENT' ? 'cursor-agent not found' : err.message);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Probe Cursor identity on the slot host. Fail-open — never throws; never returns tokens.
 */
export async function probeCursorAuthStatus(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  timeoutMs?: number;
}): Promise<CursorAuthStatus> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  // Prefer cursor-agent; some installs expose `agent` which is NOT the same CLI.
  const cursorBin = options.vars.cursorPath?.trim() || 'cursor-agent';

  try {
    if (isLocal(options.vars.host, options.vars.machine)) {
      const result = await spawnCursorStatus(cursorBin, timeoutMs);
      if (result.stdout.trim()) return parseCursorAuthStatusJson(result.stdout);
      return {
        ...EMPTY,
        error: result.stderr || (result.exitCode === null ? 'spawn-failed' : 'empty-output'),
      };
    }
    const binExpr =
      cursorBin === 'cursor-agent' ? 'cursor-agent' : shellExpressionForRemotePath(cursorBin);
    const cmd = `${binExpr} status --format json </dev/null`;
    const result = await execOnSlot(options.vars, cmd, { timeout: timeoutMs });
    if (result.stdout.trim()) return parseCursorAuthStatusJson(result.stdout);
    return {
      ...EMPTY,
      error:
        result.stderr?.trim() ||
        (result.exitCode !== 0 ? `exit ${result.exitCode}` : 'empty-output'),
    };
  } catch (err) {
    return { ...EMPTY, error: (err as Error).message || 'probe-failed' };
  }
}
