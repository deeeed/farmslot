import {
  type FlowType,
  isInteractiveDevRun,
  remoteBranchRefspec,
  type Run,
} from '@farmslot/protocol';

import { getProjectField, loadProjectVars, loadSlotVars, type SlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';
import { isGitTrue, loadGitIdentity, readGitIdentity } from '../methods/slot/git-identity.js';
import { publicationBaseForRun } from '../run-engine/stack-base.js';

/** A line iterator works in both node zsh shells and gateway Bash shells. */
export function buildCommitSignatureProbeCommand(
  repo: string,
  baseRef: string,
  headRef = 'HEAD',
  inheritedHeadSha?: string,
): string {
  const git = `git -C ${shellQuote(repo)}`;
  const inherited = inheritedHeadSha ? ` ${shellQuote(`^${inheritedHeadSha}`)}` : '';
  return (
    `commits=$(${git} rev-list ${shellQuote(`${baseRef}..${headRef}`)}${inherited} --) || exit $?; ` +
    `printf '%s\\n' "$commits" | while IFS= read -r commit; do [ -n "$commit" ] || continue; ` +
    `object=$(${git} cat-file commit "$commit") || exit $?; ` +
    `if ! printf '%s\\n' "$object" | sed '/^$/q' | grep -Eq '^gpgsig(-sha256)? '; then printf '%s\\n' "$commit"; fi; done`
  );
}

/** Inspect the actual objects: commit-tree ignores commit.gpgsign unless given -S. */
export async function assertCommitSignatures(
  vars: SlotVars,
  baseRef: string,
  headRef = 'HEAD',
  inheritedHeadSha?: string,
  fetchMissingBranch?: string,
): Promise<void> {
  const identity = await readGitIdentity(vars);
  if (!isGitTrue(loadGitIdentity()?.['commit.gpgsign']) && !isGitTrue(identity['commit.gpgsign']))
    return;
  if (fetchMissingBranch) {
    const git = `git -C ${shellQuote(vars.remoteRepo)}`;
    const present = await execOnSlot(
      vars,
      `${git} show-ref --verify --quiet ${shellQuote(baseRef)}`,
      { timeout: 10_000 },
    );
    if (present.exitCode === 1) {
      const fetched = await execOnSlot(
        vars,
        `${git} fetch origin ${shellQuote(remoteBranchRefspec(fetchMissingBranch))}`,
        { timeout: 30_000 },
      );
      if (fetched.exitCode !== 0)
        throw new Error(
          `Cannot fetch PR branch ${fetchMissingBranch} before checking inherited commit signatures: ${fetched.stderr.trim() || fetched.stdout.trim()}`,
        );
    } else if (present.exitCode !== 0) {
      throw new Error(
        `Cannot read signature base ${baseRef}: ${present.stderr.trim() || present.stdout.trim()}`,
      );
    }
  }
  // Check only the contribution, including merges, never trusted base history.
  // Read headers directly so missing local public keys cannot masquerade as
  // missing signatures. GitHub still owns account/signature verification.
  const result = await execOnSlot(
    vars,
    buildCommitSignatureProbeCommand(vars.remoteRepo, baseRef, headRef, inheritedHeadSha),
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

const COMMITTING_FLOWS = new Set<FlowType>(['dev', 'fix-bug', 'pr-complete', 'update-branch']);

/** Local commits inherited from another worker must pass before becoming trusted history. */
export async function assertInheritedPrCommitsSigned(
  run: Run | undefined,
  vars: SlotVars,
  headRef: string,
): Promise<void> {
  if (
    !run?.prNumber ||
    !run.branch ||
    !COMMITTING_FLOWS.has(run.flowType) ||
    isInteractiveDevRun(run)
  )
    return;
  const pv = await loadProjectVars(run.project);
  const base = await publicationBaseForRun(run, getProjectField(pv.projectJson, 'default_branch'));
  await assertCommitSignatures(
    vars,
    `refs/remotes/origin/${run.branch}`,
    headRef,
    `refs/remotes/origin/${base}`,
    run.branch,
  );
}

export async function assertRunCommitSignatures(run: Run): Promise<void> {
  if (!run.slotId || !run.branch || !COMMITTING_FLOWS.has(run.flowType) || isInteractiveDevRun(run))
    return;
  const vars = await loadSlotVars(run.slotId);
  const pv = await loadProjectVars(run.project);
  const base = await publicationBaseForRun(run, getProjectField(pv.projectJson, 'default_branch'));
  await assertCommitSignatures(
    vars,
    `refs/remotes/origin/${base}`,
    'HEAD',
    run.prNumber ? (run.worktreeHeadAtDispatch ?? undefined) : undefined,
  );
}
