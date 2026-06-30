import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the farmslot machine-level home directory — the single source of truth for
 * where gateway profiles, auth, logs, llm-config, and the gateway pid/log live. Both the
 * CLI and the gateway import this so a custom `FARMSLOT_HOME` can never half-apply.
 *
 * Order: `FARMSLOT_HOME` env (tilde-expanded) → `~/.farmslot`.
 */
export function farmslotHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.FARMSLOT_HOME?.trim();
  if (fromEnv) return expandTilde(fromEnv);
  return join(homedir(), '.farmslot');
}

function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}
