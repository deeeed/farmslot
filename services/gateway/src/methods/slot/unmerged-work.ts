import { execOnSlot, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';

export async function localBranchExists(
  vars: SlotVars,
  branch: string,
  exec: typeof execOnSlot = execOnSlot,
): Promise<boolean> {
  const exists = await exec(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`,
    { timeout: 15_000 },
  );
  if (exists.exitCode === 0) return true;
  if (exists.exitCode === 1) return false;
  throw new Error(`Cannot inspect local branch ${branch}; prepare left its commits untouched`);
}

/** Commits at a ref which no remote-tracking ref contains. Never hide a failed Git check. */
export async function findUnpushedSlotCommits(
  vars: SlotVars,
  ref = 'HEAD',
  exec: typeof execOnSlot = execOnSlot,
): Promise<string[]> {
  const result = await exec(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} rev-list --max-count=5 ${shellQuote(ref)} --not --remotes`,
    { timeout: 15_000 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Cannot verify unpublished commits on slot ${vars.slotId}; inspect Git refs before preparing or releasing it`,
    );
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

/** A destructive prepare must stop before losing either the current or requested local branch. */
export async function assertPrepareCommitsPublished(
  vars: SlotVars,
  branch: string,
  exec: typeof execOnSlot = execOnSlot,
): Promise<void> {
  const refs = new Set(['HEAD']);
  if (branch && (await localBranchExists(vars, branch, exec))) refs.add(`refs/heads/${branch}`);
  // Cached remote refs cannot prove publication after another clone rewrites
  // or deletes the branch. Refresh every remote used by the publication check.
  const refreshed = await exec(vars, `git -C ${shellQuote(vars.remoteRepo)} fetch --all --prune`, {
    timeout: 15_000,
  });
  if (refreshed.exitCode !== 0)
    throw new Error(
      `Cannot refresh remote refs on ${vars.slotId}; prepare left its commits untouched`,
    );
  for (const ref of refs) {
    // An existing upstream cannot excuse unpublished work: a pushed branch may
    // have new worker commits. Rewritten histories also require an explicit decision.
    const commits = await findUnpushedSlotCommits(vars, ref, exec);
    if (commits.length)
      throw new Error(
        `Prepare refused on ${vars.slotId}: ${ref} has unpushed commits (${commits.map((sha) => sha.slice(0, 12)).join(', ')}). Push or preserve this branch before retrying; no branch was reset or deleted. To intentionally discard abandoned work, detach its worktree first, then delete that branch with git branch -D <abandoned-branch>`,
      );
  }
}

/**
 * Work on the checked-out `branch` that a slot reset would lose, as a detail
 * such as "dirty files + unpushed commits", or null when nothing is at risk.
 *
 * A commit counts as pushed once any remote-tracking ref contains it, so a slot
 * that publishes to a fork or org remote instead of `origin` is judged by where
 * the publish actually went.
 */
export async function findUnmergedSlotWork(
  vars: SlotVars,
  branch: string,
  exec: typeof execOnSlot = execOnSlot,
): Promise<string | null> {
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const dirty = (
    await exec(
      vars,
      `${git} status --porcelain 2>/dev/null | grep -v '^\?\? \.omc/' | grep -v '^\?\? \.task/' | grep -v '^\?\? \.claude/CLAUDE\\.local\\.md' | head -5`,
    )
  ).stdout.trim();
  const unpushed = (await findUnpushedSlotCommits(vars, 'HEAD', exec)).length > 0;
  // Edits in the working tree were never published anywhere: always keep them.
  if (dirty) return unpushed ? 'dirty files + unpushed commits' : 'dirty files';
  if (!unpushed) return null;
  // GitHub deletes a merged PR's branch, so commits whose branch is gone from
  // the remote the publish pushed to have nothing left to lose. Publication
  // runs `git push -u`, which records that remote as the branch's upstream;
  // push-remote config may name a different one and proves nothing. A remote
  // that cannot be asked proves nothing either, so the work stays protected.
  const remote = `$(${git} config --get ${shellQuote(`branch.${branch}.remote`)} || echo origin)`;
  const probe = await exec(
    vars,
    `${git} ls-remote --heads "${remote}" ${shellQuote(branch)} 2>/dev/null`,
  );
  if (probe.exitCode === 0 && !probe.stdout.trim()) {
    console.log(
      `[slot.release] ${vars.slotId}: remote branch '${branch}' deleted (merged) — allowing recycle`,
    );
    return null;
  }
  return 'unpushed commits';
}
