/**
 * Host-local identity extraction — never prints tokens/secrets.
 * Used by provider-account-cli probe-identity (remote-safe).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isRecord(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function decodeJwtPayload(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length < 2) return null;
  try {
    const payload = parts[1];
    const pad = '='.repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(
      payload.replace(/-/g, '+').replace(/_/g, '/') + pad,
      'base64',
    ).toString('utf8');
    const data = JSON.parse(json);
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/** Redacted Codex identity from ~/.codex/auth.json (or CODEX_HOME). */
export function probeCodexIdentityLocal() {
  const home = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  const filePath = path.join(home, 'auth.json');
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(data))
      return { loggedIn: false, email: null, planType: null, authMode: null, error: 'empty-row' };
    const authMode =
      (typeof data.auth_mode === 'string' && data.auth_mode) ||
      (typeof data.authMode === 'string' && data.authMode) ||
      null;
    let email = typeof data.email === 'string' && data.email.includes('@') ? data.email : null;
    let planType = null;
    let loggedIn = false;
    const tokens = isRecord(data.tokens) ? data.tokens : null;
    if (tokens && typeof tokens.id_token === 'string') {
      const claims = decodeJwtPayload(tokens.id_token);
      if (claims) {
        loggedIn = true;
        if (!email && typeof claims.email === 'string' && claims.email.includes('@')) {
          email = claims.email;
        }
        const openaiAuth = isRecord(claims['https://api.openai.com/auth'])
          ? claims['https://api.openai.com/auth']
          : null;
        if (openaiAuth && typeof openaiAuth.chatgpt_plan_type === 'string') {
          planType = openaiAuth.chatgpt_plan_type;
        }
      }
    }
    if (!loggedIn && (authMode || email || tokens)) loggedIn = true;
    return {
      loggedIn: Boolean(loggedIn || email),
      email,
      planType,
      authMode: authMode || (email ? 'chatgpt' : null),
    };
  } catch (err) {
    const code = err?.code;
    return {
      loggedIn: false,
      email: null,
      planType: null,
      authMode: null,
      error: code === 'ENOENT' ? 'auth-file-missing' : String(err?.message || err),
    };
  }
}

/** Redacted Grok identity from ~/.grok/auth.json. */
export function probeGrokIdentityLocal() {
  const filePath = path.join(os.homedir(), '.grok', 'auth.json');
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isRecord(data)) {
      return {
        loggedIn: false,
        email: null,
        authMode: null,
        displayName: null,
        error: 'empty-row',
      };
    }
    for (const value of Object.values(data)) {
      if (!isRecord(value)) continue;
      const email =
        typeof value.email === 'string' && value.email.includes('@') ? value.email : null;
      if (!email) continue;
      return {
        loggedIn: true,
        email,
        displayName:
          (typeof value.first_name === 'string' && value.first_name) ||
          (typeof value.name === 'string' && value.name) ||
          null,
        authMode: typeof value.auth_mode === 'string' ? value.auth_mode : null,
      };
    }
    return {
      loggedIn: false,
      email: null,
      authMode: null,
      displayName: null,
      error: 'not-logged-in',
    };
  } catch (err) {
    const code = err?.code;
    return {
      loggedIn: false,
      email: null,
      authMode: null,
      displayName: null,
      error: code === 'ENOENT' ? 'auth-file-missing' : String(err?.message || err),
    };
  }
}
