import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { farmslotHome } from '@farmslot/protocol/node/farmslot-home';

import { execOnSlot, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';

import type { CheckStep } from './shared.js';

/**
 * Git config every slot commits with: one GitHub identity signed with one key,
 * farm-wide. A slot left on its node's defaults pushed unsigned commits (or had
 * no user.email) and branch rules requiring signatures rejected them (GH013).
 */
export const GIT_IDENTITY_KEYS = [
  'user.name',
  'user.email',
  'user.signingkey',
  'commit.gpgsign',
  'gpg.format',
  'gpg.program',
] as const;

export type GitIdentity = Partial<Record<(typeof GIT_IDENTITY_KEYS)[number], string>>;

export function gitIdentityConfigPath(home = farmslotHome()): string {
  return path.join(home, 'git-identity.json');
}

/**
 * The farm's git identity from `<FARMSLOT_HOME>/git-identity.json`, keyed by git
 * config name (`{"user.email": "...", "commit.gpgsign": "true", ...}`). Null
 * when the file is absent: prepare then copies nothing.
 */
export function loadGitIdentity(home = farmslotHome()): GitIdentity | null {
  const filePath = gitIdentityConfigPath(home);
  if (!existsSync(filePath)) return null;
  const data: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`Invalid ${filePath}: expected an object of git config values`);
  }
  for (const [key, value] of Object.entries(data)) {
    if (!(GIT_IDENTITY_KEYS as readonly string[]).includes(key) || typeof value !== 'string') {
      throw new Error(
        `Invalid ${filePath}: ${key} must be one of ${GIT_IDENTITY_KEYS.join(', ')} with a string value`,
      );
    }
  }
  return data as GitIdentity;
}

/** Identity keys set in the slot repo (`local`: its own config only); unset keys are omitted. */
export async function readGitIdentity(
  vars: SlotVars,
  scope: 'local' | 'effective' = 'effective',
): Promise<GitIdentity> {
  const git = `git -C ${shellQuote(vars.remoteRepo)} config${scope === 'local' ? ' --local' : ''}`;
  const result = await execOnSlot(
    vars,
    `for k in ${GIT_IDENTITY_KEYS.join(' ')}; do printf '%s\\t%s\\n' "$k" "$(${git} --get "$k")"; done`,
    { timeout: 15_000 },
  );
  if (result.exitCode !== 0) {
    throw new Error(`cannot read git config in ${vars.remoteRepo}: ${result.stderr.trim()}`);
  }
  const identity: Record<string, string> = {};
  for (const line of result.stdout.split('\n')) {
    const [key, value] = line.split('\t');
    if (key && value) identity[key] = value;
  }
  return identity;
}

/**
 * Write the farm identity into the slot repo's local config (never global),
 * only the keys it lacks or holds differently, so the node's global config
 * cannot change what the slot commits as. `gpg.program` is skipped when the
 * program does not resolve on the slot's machine, since its path is
 * host-specific. Returns a one-line summary for the prepare step.
 */
export async function syncGitIdentity(vars: SlotVars, identity: GitIdentity): Promise<string> {
  const current = await readGitIdentity(vars, 'local');
  const changed = GIT_IDENTITY_KEYS.filter(
    (key) => identity[key] !== undefined && identity[key] !== current[key],
  );
  if (changed.length === 0) return 'Git identity up to date';

  const git = `git -C ${shellQuote(vars.remoteRepo)} config --local`;
  const writes = changed.map((key) => {
    const value = identity[key]!;
    const write = `${git} ${key} ${shellQuote(value)}`;
    return key === 'gpg.program'
      ? `if command -v ${shellQuote(value)} >/dev/null 2>&1; then ${write}; else echo ${shellQuote(`skipped gpg.program: ${value} not found`)}; fi`
      : write;
  });
  const result = await execOnSlot(vars, writes.join(' && '));
  if (result.exitCode !== 0) {
    throw new Error(
      `cannot write git identity in ${vars.remoteRepo}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const skipped = result.stdout.trim();
  return `Git identity written: ${changed.join(', ')}${skipped ? ` (${skipped})` : ''}`;
}

/** Bound for the test signature: gpg-agent can wait on a pinentry nobody answers. */
export const SIGNING_PROBE_TIMEOUT_MS = 20_000;

const isGitTrue = (value: string | undefined) => /^(true|yes|on|1)$/i.test(value ?? '');

/**
 * When the slot repo signs commits (or the farm identity asks it to), prove it
 * can: a test commit object signs (`git commit-tree -S` on the empty tree; no
 * ref is written).
 */
export async function checkCommitSigning(
  vars: SlotVars,
  farmIdentity: GitIdentity | null,
): Promise<CheckStep> {
  const name = 'git.signing';
  let identity: GitIdentity;
  try {
    identity = await readGitIdentity(vars);
  } catch (err) {
    return { name, status: 'fail', detail: (err as Error).message };
  }
  const key = identity['user.signingkey'] ?? '(no user.signingkey)';
  if (!isGitTrue(identity['commit.gpgsign'])) {
    if (isGitTrue(farmIdentity?.['commit.gpgsign'])) {
      return {
        name,
        status: 'fail',
        detail: `The farm git identity signs commits, but commit.gpgsign is ${identity['commit.gpgsign'] ?? 'unset'} in ${vars.remoteRepo} (key ${key}). Fix: run \`farmslot slot prepare ${vars.slotId}\`, which writes the farm identity into the repo`,
      };
    }
    return { name, status: 'skip', detail: 'Commit signing is off' };
  }

  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const probe = await execOnSlot(
    vars,
    `${git} commit-tree -S $(${git} hash-object -t tree /dev/null) -m 'farmslot signing probe' </dev/null 2>&1`,
    { timeout: SIGNING_PROBE_TIMEOUT_MS },
  );
  if (probe.exitCode !== 0) {
    const cause = `${probe.stdout}\n${probe.stderr}`
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(' | ');
    const fix = identity['user.signingkey']
      ? `import key ${key} on ${vars.machine} and unlock its gpg-agent`
      : 'set user.signingkey in the farm git identity and run slot prepare';
    return {
      name,
      status: 'fail',
      detail: `Commits are signed, but a test signature with key ${key} failed on ${vars.machine} (exit ${probe.exitCode})${cause ? `: ${cause}` : ''}. Fix: ${fix}`,
    };
  }
  return { name, status: 'pass', detail: `Commits sign with key ${key}` };
}
