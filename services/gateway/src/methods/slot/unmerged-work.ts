import { execOnSlot, type RawProjectJson, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { hasUserSlotChanges } from '../../fleet/slot-scaffolding.js';

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
  const unpushed = (
    await exec(vars, `${git} log --oneline HEAD --not --remotes 2>/dev/null | head -5`)
  ).stdout.trim();
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
