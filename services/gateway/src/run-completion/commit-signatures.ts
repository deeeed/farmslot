import type { Run } from '@farmslot/protocol';

import { getProjectField, loadProjectVars, loadSlotVars, type SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { isGitTrue, loadGitIdentity, readGitIdentity } from '../methods/slot/git-identity.js';
import { publicationBaseForRun } from '../run-engine/stack-base.js';

/** Inspect the actual objects: commit-tree ignores commit.gpgsign unless given -S. */
export async function assertCommitSignatures(
  vars: SlotVars,
  baseRef: string,
  headRef = 'HEAD',
): Promise<void> {
  const identity = await readGitIdentity(vars);
  if (!isGitTrue(loadGitIdentity()?.['commit.gpgsign']) && !isGitTrue(identity['commit.gpgsign']))
    return;
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  // Check only the contribution, including merges, never trusted base history.
  // Read headers directly so missing local public keys cannot masquerade as
  // missing signatures. GitHub still owns account/signature verification.
  const result = await execOnSlot(
    vars,
    `commits=$(${git} rev-list ${shellQuote(`${baseRef}..${headRef}`)} --) || exit $?; ` +
      `for commit in $commits; do object=$(${git} cat-file commit "$commit") || exit $?; ` +
      `if ! printf '%s\\n' "$object" | sed '/^$/q' | grep -Eq '^gpgsig(-sha256)? '; then printf '%s\\n' "$commit"; fi; done`,
    { timeout: 30_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Cannot check outgoing commit signatures: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
    );
  const unsigned = result.stdout.trim().split(/\s+/).filter(Boolean);
  if (unsigned.length)
    throw new Error(
      `Unsigned outgoing commit(s): ${unsigned.map((sha) => sha.slice(0, 12)).join(', ')}. ` +
        'Sign these commits before completing or publishing. ' +
        'git commit-tree requires -S even when commit.gpgsign=true.',
    );
}

const COMMITTING_FLOWS = new Set(['dev', 'fix-bug', 'pr-complete', 'ci-fix', 'update-branch']);

export async function assertRunCommitSignatures(run: Run): Promise<void> {
  if (!run.slotId || !run.branch || !COMMITTING_FLOWS.has(run.flowType)) return;
  const vars = await loadSlotVars(run.slotId);
  const pv = await loadProjectVars(run.project);
  const base = await publicationBaseForRun(run, getProjectField(pv.projectJson, 'default_branch'));
  await assertCommitSignatures(vars, `refs/remotes/origin/${base}`);
}
