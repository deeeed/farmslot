import { execOnSlot, type RawProjectJson, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { hasUserSlotChanges } from '../../fleet/slot-scaffolding.js';

/** Commits not retained by remote refs or an allowed local branch. Git failures refuse. */
export async function findUnpushedSlotCommits(
  vars: SlotVars,
  ref = 'HEAD',
  exec: typeof execOnSlot = execOnSlot,
  preservedByLocalBranch = false,
): Promise<string[]> {
  const result = await exec(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} log --oneline --max-count=5 ${shellQuote(ref)} --not --remotes${preservedByLocalBranch ? ' --branches' : ''}`,
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Cannot verify commits on ${vars.slotId} at ${ref}: ${result.stderr || result.stdout}`,
    );
  return result.stdout.trim().split('\n').filter(Boolean);
}

/** Refuse before prepare can move HEAD or reset/delete the requested run branch. */
export async function assertPrepareCommitsPublished(
  vars: SlotVars,
  branch: string,
  exec: typeof execOnSlot = execOnSlot,
): Promise<void> {
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  // Keep last-published tips reachable after upstream deletion/squash merge.
  // Never-published commits still have no remote-tracking ref and must refuse.
  const fetch = await exec(vars, `${git} fetch --all --no-prune --no-tags`, { timeout: 120_000 });
  if (fetch.exitCode !== 0)
    throw new Error(
      `Cannot verify remote commits on ${vars.slotId}; prepare left branches untouched. ${fetch.stderr || fetch.stdout}`,
    );
  const head = await exec(vars, `${git} symbolic-ref --quiet --short HEAD`);
  if (head.exitCode !== 0 && head.exitCode !== 1)
    throw new Error(
      `Cannot inspect HEAD on ${vars.slotId}; prepare left branches untouched. ${head.stderr || head.stdout}`,
    );
  const refs = ['HEAD'];
  if (branch) {
    const exists = await exec(
      vars,
      `${git} show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}`,
    );
    if (exists.exitCode === 0) refs.push(`refs/heads/${branch}`);
    else if (exists.exitCode !== 1)
      throw new Error(
        `Cannot inspect run branch ${branch}; prepare left branches untouched. ${exists.stderr || exists.stdout}`,
      );
  }
  for (const ref of refs) {
    // Detaching/resetting HEAD cannot lose commits retained by a named branch.
    // The requested branch is checked separately because prepare can move it.
    const commits = await findUnpushedSlotCommits(
      vars,
      ref,
      exec,
      ref === 'HEAD' && head.exitCode === 1,
    );
    if (commits.length)
      throw new Error(
        `Prepare refused on ${vars.slotId}: ${ref} has unpushed commits: ${commits.join('; ')}. Push or preserve them before retrying; no branch was reset or deleted.`,
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
  projectJson: RawProjectJson = {},
): Promise<string | null> {
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const status = await exec(vars, `${git} status --porcelain -z --untracked-files=all`);
  if (status.exitCode !== 0)
    throw new Error(`Cannot inspect slot work on ${vars.slotId}: ${status.stderr}`);
  const dirty = hasUserSlotChanges(status.stdout, projectJson);
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
