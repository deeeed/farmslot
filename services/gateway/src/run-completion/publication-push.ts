import type { Run } from '@farmslot/protocol';

import { loadSlotVars, type SlotVars } from '../core/config.js';
import { EXEC_TIMEOUT_EXIT_CODE, execOnSlot, type ExecResult } from '../core/exec.js';
import { withFarmGitConfig } from '../core/farm-git.js';
import {
  gitPushTimeoutError,
  gitPushTimeoutMs,
  PUBLICATION_PUSH_TIMEOUT_MS,
} from '../core/git-push-budget.js';
import { shellQuote } from '../core/tmux.js';
import { probeSlotBranchFreshness } from '../run-engine/branch-freshness.js';

export { PUBLICATION_PUSH_TIMEOUT_MS };

export const BRANCH_PUBLICATION_FLOWS = new Set<string>([
  'pr-complete',
  'dev',
  'fix-bug',
  'update-branch',
]);

/** Check origin itself: a local tracking ref can be stale or optimistically advanced. */
export async function assertPublicationRemoteHead(
  run: Run,
  headSha: string | undefined,
  branch = run.branch,
): Promise<void> {
  if (!run.slotId || !branch || !headSha)
    throw new Error('Publication requires an assigned slot, branch and captured HEAD');
  const vars = await loadSlotVars(run.slotId);
  const ref = `refs/heads/${branch}`;
  const remote = await execOnSlot(
    vars,
    withFarmGitConfig(
      `git -C ${shellQuote(vars.remoteRepo)} ls-remote --exit-code origin ${shellQuote(ref)}`,
    ),
    { timeout: 30_000 },
  );
  const actual = remote.stdout
    .trim()
    .split('\n')
    .map((line) => line.split(/\s+/))
    .find(([, name]) => name === ref)?.[0];
  if (remote.exitCode !== 0 || actual !== headSha)
    throw new Error(
      `Publication remote HEAD mismatch for ${branch}: expected ${headSha}, got ${actual || 'missing'}${remote.stderr.trim() ? `; ${remote.stderr.trim().slice(-1500)}` : ''}`,
    );
}

/** Existing PRs need the same push and hook checks as newly created PRs. */
export async function pushPublicationBranch(
  run: Run,
  headSha: string | undefined,
  baseBranch: string,
  branch = run.branch,
): Promise<void> {
  if (!run.slotId || !branch || !headSha)
    throw new Error('Publication requires an assigned slot, branch and captured HEAD');
  const vars = await loadSlotVars(run.slotId);
  const timeout = await gitPushTimeoutMs(vars);
  await assertPublicationMergeable(vars, headSha, baseBranch);
  const push = await execOnSlot(
    vars,
    withFarmGitConfig(`git -C ${shellQuote(vars.remoteRepo)} push -u origin ${shellQuote(branch)}`),
    { timeout },
  );
  assertPublicationBranchPushed(push, branch, run.id, timeout);
  await assertPublicationRemoteHead(run, headSha, branch);
  // Pre-push hooks can take minutes; check the base again before publishing PR metadata.
  await assertPublicationMergeable(vars, headSha, baseBranch);
}

async function assertPublicationMergeable(
  vars: SlotVars,
  headSha: string,
  baseBranch: string,
): Promise<void> {
  const probe = await probeSlotBranchFreshness(vars, baseBranch);
  if (!probe?.fetchOk || !probe.remoteRefOk || typeof probe.mergeConflicts !== 'boolean')
    throw new Error(`PUBLICATION_MERGEABILITY_UNAVAILABLE: cannot verify origin/${baseBranch}`);
  if (probe.headSha !== headSha)
    throw new Error(
      `Publication HEAD drift: expected ${headSha}, got ${probe.headSha || 'unknown'}`,
    );
  if (probe.mergeConflicts) throw new Error(`PUBLICATION_MERGE_CONFLICT: ${probe.hint}`);
}

/**
 * A refused push (the repository's pre-push hook, or the remote) leaves no branch to open a
 * PR from, and GitHub would then report only a blank head. Stop publication with its error.
 */
export function assertPublicationBranchPushed(
  push: ExecResult,
  branch: string,
  runId: string,
  timeoutMs = PUBLICATION_PUSH_TIMEOUT_MS,
): void {
  if (push.exitCode === 0) return;
  // A hook prints its findings on stdout, ahead of its closing hints: keep them in the log.
  console.warn(
    `[run-completion] run ${runId.slice(0, 8)} — git push output: ${push.stdout.slice(-20_000)}`,
  );
  if (push.exitCode === EXEC_TIMEOUT_EXIT_CODE) throw gitPushTimeoutError(timeoutMs);
  throw new Error(
    `git push of ${branch} failed (exit ${push.exitCode}); the repository's pre-push hook, the remote or the push timeout stopped it (hook output is in the gateway log): ${push.stderr.trim().slice(-1500) || 'no error output'}`,
  );
}
