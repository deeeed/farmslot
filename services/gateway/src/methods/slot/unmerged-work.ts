import { DEFAULT_BRANCH, type ExecResult, remoteBranchRefspec } from '@farmslot/protocol';

import { EXEC_TIMEOUT_EXIT_CODE } from '../../core/exec.js';
import { execOnSlot, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';

function prepareGitFailure(message: string, result: ExecResult): Error {
  return new Error(
    `${message} (${result.exitCode === EXEC_TIMEOUT_EXIT_CODE ? 'timeout' : 'exit'} ${result.exitCode}): ${(result.stderr || result.stdout).slice(-200)}`,
  );
}

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
  throw prepareGitFailure(
    `Cannot inspect local branch ${branch}; prepare left its commits untouched`,
    exists,
  );
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
  defaultBranch = DEFAULT_BRANCH,
  preserveUnpublished = false,
): Promise<void> {
  const refs = new Set(['HEAD']);
  if (branch && (await localBranchExists(vars, branch, exec))) refs.add(`refs/heads/${branch}`);
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const remoteResult = await exec(vars, `${git} remote`);
  if (remoteResult.exitCode !== 0)
    throw prepareGitFailure('Cannot inspect Git remotes', remoteResult);
  const remotes = remoteResult.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const currentResult = await exec(vars, `${git} symbolic-ref --quiet --short HEAD`);
  if (currentResult.exitCode !== 0 && currentResult.exitCode !== 1)
    throw prepareGitFailure('Cannot inspect current branch', currentResult);
  const currentBranch = currentResult.stdout.trim();
  const refreshed = new Set<string>();
  const protectedTips = new Set<string>();
  for (const ref of refs) {
    const tipResult = await exec(vars, `${git} rev-parse ${shellQuote(ref)}`);
    if (tipResult.exitCode !== 0) throw prepareGitFailure(`Cannot inspect ${ref}`, tipResult);
    const tip = tipResult.stdout.trim();
    if (protectedTips.has(tip)) continue;
    const candidates = new Set<string>();
    for (const name of [currentBranch, branch, defaultBranch])
      if (name) for (const remote of remotes) candidates.add(`refs/remotes/${remote}/${name}`);
    // Cached refs are candidate names only. They never count as publication
    // evidence until that exact ref has been refreshed, including narrow clones.
    const containing = await exec(
      vars,
      `${git} for-each-ref --contains=${shellQuote(tip)} --format='%(refname)' refs/remotes`,
    );
    if (containing.exitCode !== 0)
      throw prepareGitFailure('Cannot inspect publication candidates', containing);
    for (const candidate of containing.stdout.trim().split(/\s+/).filter(Boolean))
      candidates.add(candidate);
    let published = false;
    for (const candidate of candidates) {
      const remote = remotes.find((name) => candidate.startsWith(`refs/remotes/${name}/`));
      if (!remote) continue;
      const name = candidate.slice(`refs/remotes/${remote}/`.length);
      if (name === 'HEAD') continue;
      if (!refreshed.has(candidate)) {
        // Fetch only possible backing refs. A full fetch on MetaMask's thousands
        // of branches can take minutes and is unnecessary for this proof.
        const fetch = await exec(
          vars,
          `${git} fetch ${shellQuote(remote)} ${shellQuote(remoteBranchRefspec(name, remote))}`,
        );
        if (fetch.exitCode !== 0) {
          const exists = await exec(
            vars,
            `${git} ls-remote --exit-code --heads ${shellQuote(remote)} ${shellQuote(`refs/heads/${name}`)}`,
          );
          if (exists.exitCode !== 2)
            throw prepareGitFailure(
              `Cannot verify publication ref ${candidate}; current work preserved`,
              fetch,
            );
          const prune = await exec(vars, `${git} update-ref -d ${shellQuote(candidate)}`);
          if (prune.exitCode !== 0)
            throw prepareGitFailure(`Cannot remove stale publication ref ${candidate}`, prune);
          continue;
        }
        refreshed.add(candidate);
      }
      const contains = await exec(
        vars,
        `${git} merge-base --is-ancestor ${shellQuote(tip)} ${shellQuote(candidate)}`,
      );
      if (contains.exitCode === 0) {
        published = true;
        break;
      }
      if (contains.exitCode !== 1)
        throw prepareGitFailure(`Cannot verify commits against ${candidate}`, contains);
    }
    if (!published && preserveUnpublished) {
      const preserved = `refs/farmslot/preserved/${tip}`;
      const backup = await exec(
        vars,
        `${git} update-ref ${shellQuote(preserved)} ${shellQuote(tip)}`,
      );
      if (backup.exitCode !== 0)
        throw prepareGitFailure(`Cannot preserve ${ref}; current work untouched`, backup);
      console.log(
        `[prepare] preserved ${ref} at ${preserved} before refreshing the review workspace`,
      );
      protectedTips.add(tip);
      continue;
    }
    if (!published)
      throw new Error(
        `Prepare refused on ${vars.slotId}: ${ref} has unpushed commits or an unverified tip (${tip.slice(0, 12)}). Push or preserve this branch before retrying; no branch was reset or deleted. To intentionally discard abandoned work, detach its worktree first, then delete that branch with git branch -D <abandoned-branch>`,
      );
    protectedTips.add(tip);
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
