// auth-resolve.ts — Auth cascade for LLM providers
// Resolution order:
//   1. Farmslot's own store (<FARMSLOT_HOME>/auth-profiles.json, default ~/.farmslot)
//   2. OpenClaw import (~/.openclaw/agents/main/agent/auth-profiles.json)
//   3. Env vars (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
//   4. null → caller falls back to CLI

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { refreshIfExpiringSoon } from './auth-refresh.js';
import {
  extractRawAccessToken,
  getFarmslotStorePath,
  getOpenClawStorePath,
  listProfilesForProvider,
  loadAuthProfileStore,
} from './auth-store.js';

export interface ResolvedAuth {
  apiKey: string;
  source: string; // e.g. "farmslot:anthropic:default", "openclaw:anthropic:default", "env:ANTHROPIC_API_KEY"
}

const PROVIDER_ENV_VARS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
};

export function getProviderEnvVars(): Record<string, string[]> {
  return PROVIDER_ENV_VARS;
}

export async function resolveAuth(provider: string): Promise<ResolvedAuth | null> {
  // 1. Farmslot's own store. OAuth credentials get a proactive refresh when
  // they're within the expiry window so the caller never sees an expired
  // access token (failure mode that previously showed up as silent codex
  // empty responses with HTTP 401 token_expired).
  const farmslotStore = await loadAuthProfileStore(getFarmslotStorePath());
  if (farmslotStore) {
    const profiles = listProfilesForProvider(farmslotStore, provider);
    for (const { profileId, credential } of profiles) {
      const fresh = await refreshIfExpiringSoon(profileId, credential);
      const key = extractRawAccessToken(fresh);
      if (key) return { apiKey: key, source: `farmslot:${profileId}` };
    }
  }

  // 2. OpenClaw import (read-only)
  const openclawStore = await loadAuthProfileStore(getOpenClawStorePath());
  if (openclawStore) {
    const profiles = listProfilesForProvider(openclawStore, provider);
    for (const { profileId, credential } of profiles) {
      const key = extractRawAccessToken(credential);
      if (key) return { apiKey: key, source: `openclaw:${profileId}` };
    }
  }

  // 3. Env vars
  const envVars = PROVIDER_ENV_VARS[provider] ?? [];
  for (const varName of envVars) {
    const val = process.env[varName];
    if (val) return { apiKey: val, source: `env:${varName}` };
  }

  // 4. Codex CLI auth (~/.codex/auth.json) — OAuth access token
  if (provider === 'openai-codex') {
    const token = readCodexCliToken();
    if (token) return { apiKey: token, source: 'codex-cli:auth.json' };
  }

  // 5. No auth found
  return null;
}

function readCodexCliToken(): string | null {
  const authPath = path.join(homedir(), '.codex', 'auth.json');
  try {
    if (!existsSync(authPath)) return null;
    const raw = JSON.parse(readFileSync(authPath, 'utf-8'));
    const token = raw?.tokens?.access_token;
    if (typeof token !== 'string' || token.length < 50) return null;
    // Check JWT expiry — tokens have an `exp` claim (seconds since epoch)
    const parts = token.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
        console.warn('[llm] codex CLI access token expired — run `codex auth` to refresh');
        return null;
      }
    }
    return token;
  } catch (err) {
    console.warn('[llm] codex auth.json read failed:', (err as Error).message);
    return null;
  }
}

/**
 * Import auth profiles from a remote machine's OpenClaw installation via SSH.
 * Returns the parsed store or null on failure.
 */
export async function importRemoteOpenClaw(
  host: string,
  sshUser: string,
): Promise<import('./auth-store.js').AuthProfileStore | null> {
  // Validate inputs to prevent command injection
  if (!/^[\w.-]+$/.test(host) || !/^[\w.-]+$/.test(sshUser)) {
    console.warn(`[llm] invalid host or sshUser for remote import: ${host} / ${sshUser}`);
    return null;
  }

  const { execLocal } = await import('../core/exec.js');
  const remotePath = '~/.openclaw/agents/main/agent/auth-profiles.json';

  try {
    const result = await execLocal(
      `ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${sshUser}@${host} 'cat ${remotePath}'`,
      { timeout: 10000 },
    );

    if (result.exitCode !== 0) {
      console.warn(
        `[llm] remote OpenClaw import failed (ssh ${sshUser}@${host}): ${result.stderr.slice(0, 200)}`,
      );
      return null;
    }

    return JSON.parse(result.stdout);
  } catch (err) {
    console.warn(`[llm] remote OpenClaw import error: ${(err as Error).message}`);
    return null;
  }
}
