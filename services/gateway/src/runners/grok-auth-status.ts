/**
 * Fail-open Grok identity probe from host-local `~/.grok/auth.json`.
 * Grok CLI has no stable `auth status` JSON — email lives in the auth cache.
 * Never returns tokens/secrets — email + display name only.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { loadSlotVars } from '../core/config.js';
import { isLocal } from '../core/exec.js';

export interface GrokAuthStatus {
  loggedIn: boolean;
  email: string | null;
  displayName: string | null;
  /** e.g. oidc / grok.com */
  authMode: string | null;
  error?: string;
}

const EMPTY: GrokAuthStatus = {
  loggedIn: false,
  email: null,
  displayName: null,
  authMode: null,
};

const SECRET_KEY = /token|secret|password|refresh|access|cookie|jwt|authorization|key$/iu;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Walk auth.json and pick the first profile entry that has an email.
 * Structure: { "https://auth.x.ai::clientId": { email, first_name, auth_mode, refresh_token, … } }
 */
export function parseGrokAuthJson(raw: string): GrokAuthStatus {
  const trimmed = raw.trim();
  if (!trimmed) return { ...EMPTY, error: 'empty-output' };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { ...EMPTY, error: 'unparseable' };
  }
  if (!isRecord(data)) return { ...EMPTY, error: 'empty-row' };

  // Prefer nested profile objects (OIDC entries), then top-level email.
  const candidates: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (SECRET_KEY.test(key)) continue;
    if (isRecord(value)) candidates.push(value);
  }
  if (typeof data.email === 'string') candidates.push(data);

  for (const row of candidates) {
    const email =
      typeof row.email === 'string' && row.email.includes('@') ? row.email.trim() : null;
    if (!email) continue;
    const first =
      (typeof row.first_name === 'string' && row.first_name.trim()) ||
      (typeof row.display_name === 'string' && row.display_name.trim()) ||
      (typeof row.name === 'string' && row.name.trim()) ||
      null;
    const authMode =
      (typeof row.auth_mode === 'string' && row.auth_mode.trim()) ||
      (typeof row.authMode === 'string' && row.authMode.trim()) ||
      null;
    return {
      loggedIn: true,
      email,
      displayName: first,
      authMode,
    };
  }

  // Logged-in signal without email (rare).
  if (candidates.some((r) => typeof r.user_id === 'string' || typeof r.principal_id === 'string')) {
    return { ...EMPTY, loggedIn: true, authMode: 'grok.com', error: 'no-email' };
  }
  return { ...EMPTY, error: 'not-logged-in' };
}

export function formatGrokAuthLoginMethod(status: GrokAuthStatus): string | null {
  if (status.authMode) return `grok.com · ${status.authMode}`;
  if (status.loggedIn || status.email) return 'grok.com';
  return null;
}

function localGrokAuthPath(): string {
  return path.join(os.homedir(), '.grok', 'auth.json');
}

/**
 * Probe Grok identity on the slot host. Fail-open — never throws; never returns tokens.
 */
export async function probeGrokAuthStatus(options: {
  vars: Awaited<ReturnType<typeof loadSlotVars>>;
  timeoutMs?: number;
}): Promise<GrokAuthStatus> {
  try {
    if (isLocal(options.vars.host, options.vars.machine)) {
      try {
        const raw = readFileSync(localGrokAuthPath(), 'utf8');
        return parseGrokAuthJson(raw);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        return {
          ...EMPTY,
          error: code === 'ENOENT' ? 'auth-file-missing' : (err as Error).message,
        };
      }
    }

    // Remote: identity-only CLI (never cat full auth.json over the wire).
    const { hostProbeIdentity } = await import('./provider-account-host.js');
    const probed = await hostProbeIdentity({ vars: options.vars, provider: 'grok' });
    return {
      loggedIn: Boolean(probed.loggedIn || probed.email),
      email: probed.email,
      displayName: probed.displayName,
      authMode: probed.authMode,
      ...(probed.error && !probed.email ? { error: probed.error } : {}),
    };
  } catch (err) {
    return { ...EMPTY, error: (err as Error).message || 'probe-failed' };
  }
}
