/**
 * Fail-open Codex identity probe.
 * - Preferred: decode email/plan claims from ~/.codex/auth.json id_token payload
 *   (never returns tokens / raw JWT).
 * - Fallback signal: `codex login status` text ("Logged in using ChatGPT").
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { loadSlotVars } from '../core/config.js';
import { execOnSlot, isLocal } from '../core/exec.js';
import { shellExpressionForRemotePath } from '../core/remote-paths.js';

export interface CodexAuthStatus {
  loggedIn: boolean;
  email: string | null;
  /** e.g. pro, plus, team from ChatGPT plan claim */
  planType: string | null;
  /** e.g. chatgpt / api-key */
  authMode: string | null;
  error?: string;
}

const EMPTY: CodexAuthStatus = {
  loggedIn: false,
  email: null,
  planType: null,
  authMode: null,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Base64url-decode JWT payload only — never verify, never return the token. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1]!;
    const pad = '='.repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/') + pad,
      'base64',
    ).toString('utf8');
    const data: unknown = JSON.parse(json);
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** Extract identity fields from Codex auth.json (tokens discarded). */
export function parseCodexAuthJson(raw: string): CodexAuthStatus {
  const trimmed = raw.trim();
  if (!trimmed) return { ...EMPTY, error: 'empty-output' };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { ...EMPTY, error: 'unparseable' };
  }
  if (!isRecord(data)) return { ...EMPTY, error: 'empty-row' };

  const authMode =
    (typeof data.auth_mode === 'string' && data.auth_mode.trim()) ||
    (typeof data.authMode === 'string' && data.authMode.trim()) ||
    null;

  let email: string | null =
    typeof data.email === 'string' && data.email.includes('@') ? data.email.trim() : null;
  let planType: string | null = null;
  let loggedIn = false;

  const tokens = isRecord(data.tokens) ? data.tokens : null;
  const idToken = tokens && typeof tokens.id_token === 'string' ? tokens.id_token : null;
  if (idToken) {
    const claims = decodeJwtPayload(idToken);
    if (claims) {
      loggedIn = true;
      if (!email && typeof claims.email === 'string' && claims.email.includes('@')) {
        email = claims.email.trim();
      }
      const openaiAuth = isRecord(claims['https://api.openai.com/auth'])
        ? claims['https://api.openai.com/auth']
        : null;
      if (openaiAuth && typeof openaiAuth.chatgpt_plan_type === 'string') {
        planType = openaiAuth.chatgpt_plan_type.trim();
      }
    }
  }

  if (!loggedIn && (authMode || email || data.OPENAI_API_KEY || tokens)) {
    loggedIn = true;
  }

  if (!email && !loggedIn) {
    return { ...EMPTY, authMode, error: 'not-logged-in' };
  }

  return {
    loggedIn: Boolean(loggedIn || email),
    email,
    planType,
    authMode: authMode ?? (email ? 'chatgpt' : null),
  };
}

/** Parse `codex login status` human text. */
export function parseCodexLoginStatusText(stdout: string): CodexAuthStatus {
  const text = stdout.trim();
  if (!text) return { ...EMPTY, error: 'empty-output' };
  const lower = text.toLowerCase();
  if (/not logged in|logged out|unauthenticated/i.test(text)) {
    return { ...EMPTY, error: 'not-logged-in' };
  }
  const using = text.match(/logged in using\s+(.+)/i);
  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (/logged in/i.test(lower) || using || emailMatch) {
    const method = using?.[1]?.trim() || null;
    return {
      loggedIn: true,
      email: emailMatch?.[0] ?? null,
      planType: null,
      authMode: method ? method.toLowerCase().replace(/\s+/g, '-') : 'chatgpt',
    };
  }
  return { ...EMPTY, error: 'unparseable' };
}

export function formatCodexAuthLoginMethod(status: CodexAuthStatus): string | null {
  const parts: string[] = [];
  if (status.planType) parts.push(status.planType);
  if (status.authMode) parts.push(status.authMode);
  return parts.length ? parts.join(' · ') : status.loggedIn ? 'chatgpt' : null;
}

function localCodexAuthPath(): string {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

function spawnCodexLoginStatus(
  codexBin: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(codexBin, ['login', 'status'], {
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
      finish(null, code === 'ENOENT' ? 'codex not found' : err.message);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * Probe Codex identity on the slot host. Prefer auth.json claims; fall back to login status.
 * Fail-open — never throws; never returns tokens.
 */
export async function probeCodexAuthStatus(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  timeoutMs?: number;
}): Promise<CodexAuthStatus> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const codexBin = options.vars.codexPath?.trim() || 'codex';

  try {
    if (isLocal(options.vars.host, options.vars.machine)) {
      try {
        const raw = readFileSync(localCodexAuthPath(), 'utf8');
        const fromFile = parseCodexAuthJson(raw);
        if (fromFile.email || fromFile.loggedIn) return fromFile;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          // continue to CLI
        }
      }
      const result = await spawnCodexLoginStatus(codexBin, timeoutMs);
      if (result.stdout.trim()) return parseCodexLoginStatusText(result.stdout);
      return {
        ...EMPTY,
        error: result.stderr || (result.exitCode === null ? 'spawn-failed' : 'empty-output'),
      };
    }

    // Remote: identity-only CLI (never cat full auth.json over the wire).
    const { hostProbeIdentity } = await import('./provider-account-host.js');
    const probed = await hostProbeIdentity({ vars: options.vars, provider: 'codex' });
    if (probed.email || probed.loggedIn) {
      return {
        loggedIn: Boolean(probed.loggedIn || probed.email),
        email: probed.email,
        planType: probed.planType,
        authMode: probed.authMode,
      };
    }
    const binExpr = codexBin === 'codex' ? 'codex' : shellExpressionForRemotePath(codexBin);
    const statusResult = await execOnSlot(options.vars, `${binExpr} login status </dev/null`, {
      timeout: timeoutMs,
    });
    if (statusResult.stdout.trim()) return parseCodexLoginStatusText(statusResult.stdout);
    return {
      ...EMPTY,
      error: probed.error || statusResult.stderr?.trim() || 'auth-file-missing',
    };
  } catch (err) {
    return { ...EMPTY, error: (err as Error).message || 'probe-failed' };
  }
}
