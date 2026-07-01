// onboarding/env-file.ts — load a checkout's `.env` config into process.env at CLI startup.
//
// Mirrors what scripts/dev.sh already does for the dev stack, so `yarn farmslot` and the
// cdp probes honor the same per-checkout config (FARMSLOT_HOME, GW_URL, ports) without a
// separate sourced file. The shell environment always wins — a file only fills what the
// shell hasn't already set. No-op for installed clones (they have no such files).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Checkout env files the CLI reads, in order. `.env.ports` is the primary dev-config file. */
export const CHECKOUT_ENV_FILES = ['.env.ports', '.env'] as const;

/** Parse a dotenv-style file: `KEY=VALUE` per line, `#` comments, optional surrounding quotes.
 * Values are left literal (no `$VAR` expansion); a leading `~` is fine — farmslotHome() and
 * the CLI's own path handling expand it, matching how the shell would. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && (val[0] === '"' || val[0] === "'") && val[val.length - 1] === val[0]) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Load `<checkoutRoot>/.env.ports` then `.env` into `env`, without overriding values already
 * present (shell wins). Absent files and read errors are ignored — config must never crash
 * the CLI, and the shell env still applies.
 */
export function loadCheckoutEnv(checkoutRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const name of CHECKOUT_ENV_FILES) {
    const path = join(checkoutRoot, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      // Unreadable env file (perms/race) — skip it; the shell environment still applies.
      continue;
    }
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      if (env[key] === undefined) env[key] = value;
    }
  }
}
