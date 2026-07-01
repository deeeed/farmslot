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

/** Parse a minimal `KEY=VALUE`-per-line env file: full-line `#` comments only (no inline
 * comments), an optional `export ` prefix, and one pair of surrounding quotes stripped (no
 * escape sequences). Values are left literal (no `$VAR` expansion); a leading `~` is fine —
 * farmslotHome() and the CLI's own path handling expand it, matching shell `source`. */
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
 * present (shell wins). Absent files are skipped; a present-but-unreadable file throws so a
 * misconfigured checkout can't silently apply the wrong FARMSLOT_HOME / GW_URL.
 */
export function loadCheckoutEnv(checkoutRoot: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const name of CHECKOUT_ENV_FILES) {
    const path = join(checkoutRoot, name);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch (err) {
      // A file that vanished between existsSync and read (ENOENT race) is fine to skip;
      // anything else (e.g. EACCES) means the config is present but unreadable — surface it
      // rather than silently applying the wrong config.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      if (env[key] === undefined) env[key] = value;
    }
  }
}
