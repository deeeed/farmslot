import { execOnSlot, type RawProjectJson, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { ghRequest } from '../../integrations/github-client.js';
import { githubRepositorySlugFromUrl } from '../../intelligence/feedback-candidates.js';

import type { CheckStep } from './shared.js';

/**
 * Git config every slot commits with. Copied from the project's reference slot
 * (`git_identity_slot`) so all slots push as one GitHub identity, signed with
 * one key; a slot with its node's defaults pushed unsigned commits that branch
 * rules requiring signatures reject (GH013).
 */
export const GIT_IDENTITY_KEYS = [
  'user.name',
  'user.email',
  'user.signingkey',
  'commit.gpgsign',
  'gpg.format',
  'gpg.program',
] as const;

/** Effective (local + global) value of each identity key in the slot repo; unset keys are omitted. */
export async function readGitIdentity(vars: SlotVars): Promise<Record<string, string>> {
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const result = await execOnSlot(
    vars,
    `for k in ${GIT_IDENTITY_KEYS.join(' ')}; do printf '%s\\t%s\\n' "$k" "$(${git} config --get "$k")"; done`,
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
 * Write the reference slot's identity into the slot repo's local config. Only
 * keys that differ are written. `gpg.program` is skipped when the program does
 * not resolve on the slot's machine, since its path is host-specific.
 * Returns a one-line summary for the prepare step.
 */
export async function syncGitIdentity(vars: SlotVars, referenceVars: SlotVars): Promise<string> {
  const referenceSlot = referenceVars.slotId;
  const reference = await readGitIdentity(referenceVars);
  const current = await readGitIdentity(vars);
  const changed = GIT_IDENTITY_KEYS.filter(
    (key) => reference[key] !== undefined && reference[key] !== current[key],
  );
  if (changed.length === 0) return `Git identity matches ${referenceSlot}`;

  const git = `git -C ${shellQuote(vars.remoteRepo)} config --local`;
  const writes = changed.map((key) => {
    const write = `${git} ${key} ${shellQuote(reference[key]!)}`;
    return key === 'gpg.program'
      ? `if command -v ${shellQuote(reference[key]!)} >/dev/null 2>&1; then ${write}; else echo "skipped gpg.program: ${reference[key]} not found"; fi`
      : write;
  });
  const result = await execOnSlot(vars, writes.join(' && '));
  if (result.exitCode !== 0) {
    throw new Error(
      `cannot write git identity in ${vars.remoteRepo}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const skipped = result.stdout.trim();
  return `Git identity copied from ${referenceSlot}: ${changed.join(', ')}${skipped ? ` (${skipped})` : ''}`;
}

async function githubBranchRuleTypes(repo: string, branch: string): Promise<string[]> {
  const { stdout } = await ghRequest(['api', `repos/${repo}/rules/branches/${branch}`]);
  return (JSON.parse(stdout) as { type?: string }[]).map((rule) => rule.type ?? '');
}

/** Bound for the test signature: gpg-agent can wait on a pinentry nobody answers. */
export const SIGNING_PROBE_TIMEOUT_MS = 20_000;

/**
 * When the branch rules of the slot's current branch require signed commits,
 * prove the slot repo can sign: `commit.gpgsign` is on and a test commit
 * object signs (`git commit-tree -S` on the empty tree; no ref is written).
 */
export async function checkCommitSigning(
  vars: SlotVars,
  projectJson: RawProjectJson,
  defaultBranch: string,
  branchRuleTypes: (repo: string, branch: string) => Promise<string[]> = githubBranchRuleTypes,
): Promise<CheckStep> {
  const name = 'git.signing';
  const repo = projectJson.ci?.repo || githubRepositorySlugFromUrl(projectJson.repo_url);
  if (!repo) {
    return { name, status: 'skip', detail: 'No GitHub repository configured' };
  }
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const head = (await execOnSlot(vars, `${git} rev-parse --abbrev-ref HEAD 2>/dev/null`)).stdout
    .trim()
    .replace(/^HEAD$/, '');
  const branch = head || defaultBranch;

  let required: boolean;
  try {
    required = (await branchRuleTypes(repo, branch)).includes('required_signatures');
  } catch (err) {
    return {
      name,
      status: 'warn',
      detail: `No verdict: cannot read ${repo} branch rules (${(err as Error).message.split('\n')[0]})`,
    };
  }
  if (!required) {
    return { name, status: 'pass', detail: `${repo} does not require signed commits on ${branch}` };
  }

  let identity: Record<string, string>;
  try {
    identity = await readGitIdentity(vars);
  } catch (err) {
    return { name, status: 'fail', detail: (err as Error).message };
  }
  const key = identity['user.signingkey'] ?? '(no user.signingkey)';
  const fix = projectJson.git_identity_slot
    ? `prepare copies it from ${projectJson.git_identity_slot}`
    : 'set git_identity_slot in project.json to a slot that signs';
  if (!/^(true|yes|on|1)$/i.test(identity['commit.gpgsign'] ?? '')) {
    return {
      name,
      status: 'fail',
      detail: `${repo} requires signed commits on ${branch}, but commit.gpgsign is ${identity['commit.gpgsign'] ?? 'unset'} in ${vars.remoteRepo} (key ${key}). Fix: ${fix}`,
    };
  }
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
    return {
      name,
      status: 'fail',
      detail: `${repo} requires signed commits on ${branch}, but a test signature with key ${key} failed on ${vars.machine} (exit ${probe.exitCode})${cause ? `: ${cause}` : ''}. Fix: ${identity['user.signingkey'] ? `import key ${key} and make its gpg-agent usable on ${vars.machine}` : fix}`,
    };
  }
  return { name, status: 'pass', detail: `Commits on ${branch} sign with key ${key}` };
}
