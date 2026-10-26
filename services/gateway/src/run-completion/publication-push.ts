import type { Run } from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot, type ExecResult } from '../core/exec.js';
import { shellQuote } from '../core/tmux.js';

/** The push runs the repository's pre-push hook: MetaMask/core's `yarn lint` takes ~3 minutes. */
export const PUBLICATION_PUSH_TIMEOUT_MS = 600_000;

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
    `git -C ${shellQuote(vars.remoteRepo)} ls-remote --exit-code origin ${shellQuote(ref)}`,
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
  branch = run.branch,
): Promise<void> {
  if (!run.slotId || !branch || !headSha)
    throw new Error('Publication requires an assigned slot, branch and captured HEAD');
  const vars = await loadSlotVars(run.slotId);
  const head = await execOnSlot(vars, `git -C ${shellQuote(vars.remoteRepo)} rev-parse HEAD`, {
    timeout: 15_000,
  });
  if (head.exitCode !== 0 || head.stdout.trim() !== headSha)
    throw new Error(
      `Publication HEAD drift: expected ${headSha}, got ${head.stdout.trim() || 'unknown'}`,
    );
  const push = await execOnSlot(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} push -u origin ${shellQuote(branch)}`,
    { timeout: PUBLICATION_PUSH_TIMEOUT_MS },
  );
  assertPublicationBranchPushed(push, branch, run.id);
  await assertPublicationRemoteHead(run, headSha, branch);
}

/**
 * A refused push (the repository's pre-push hook, or the remote) leaves no branch to open a
 * PR from, and GitHub would then report only a blank head. Stop publication with its error.
 */
export function assertPublicationBranchPushed(
  push: ExecResult,
  branch: string,
  runId: string,
): void {
  if (push.exitCode === 0) return;
  // A hook prints its findings on stdout, ahead of its closing hints: keep them in the log.
  console.warn(
    `[run-completion] run ${runId.slice(0, 8)} — git push output: ${push.stdout.slice(-20_000)}`,
  );
  throw new Error(
    `git push of ${branch} failed (exit ${push.exitCode}); the repository's pre-push hook, the remote or the push timeout stopped it (hook output is in the gateway log): ${push.stderr.trim().slice(-1500) || 'no error output'}`,
  );
}
