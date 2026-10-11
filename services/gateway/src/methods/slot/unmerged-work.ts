import { DEFAULT_BRANCH, type ExecResult } from '@farmslot/protocol';

import { EXEC_TIMEOUT_EXIT_CODE } from '../../core/exec.js';
import {
  fetchRemoteBranch,
  probeRemoteBranch,
  type RemoteBranchProbe,
} from '../../core/git-remote.js';
import { execOnSlot, type RawProjectJson, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { hasUserSlotChanges } from '../../fleet/slot-scaffolding.js';

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

/** Dirty status has one owner for prepare and release, including framework artifacts. */
export async function slotHasUserChanges(
  vars: SlotVars,
  projectJson: RawProjectJson,
  exec: typeof execOnSlot = execOnSlot,
): Promise<boolean> {
  const status = await exec(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} status --porcelain -z --untracked-files=all`,
  );
  if (status.exitCode !== 0)
    throw prepareGitFailure(`Cannot inspect slot work on ${vars.slotId}`, status);
  return hasUserSlotChanges(status.stdout, projectJson);
}

/** A reused source slot may hold another run. Protect this run's named branch,
 * and its working tree only when HEAD belongs to that branch. Detached work with
 * no named branch cannot be attributed safely, so retain the conservative guard. */
export async function assertRecoverySourceWorkSafe(
  vars: SlotVars,
  branch: string,
  projectJson: RawProjectJson,
  defaultBranch = DEFAULT_BRANCH,
  exec: typeof execOnSlot = execOnSlot,
): Promise<void> {
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const current = await exec(vars, `${git} symbolic-ref --quiet --short HEAD`);
  if (current.exitCode !== 0 && current.exitCode !== 1)
    throw prepareGitFailure('Cannot inspect recovery source branch', current);
  let includeHead = current.stdout.trim() === branch;
  if (current.exitCode === 1) {
    includeHead = true;
    if (await localBranchExists(vars, branch, exec)) {
      const tips = await exec(vars, `${git} rev-parse HEAD ${shellQuote(`refs/heads/${branch}`)}`);
      if (tips.exitCode !== 0)
        throw prepareGitFailure('Cannot inspect detached recovery source', tips);
      const [head, branchTip] = tips.stdout.trim().split(/\s+/);
      includeHead = head === branchTip;
    }
  }
  if (includeHead && (await slotHasUserChanges(vars, projectJson, exec))) {
    throw new Error(
      `Replay cannot preserve ${branch}: original work on ${vars.slotId} has dirty files. Commit, push or preserve them before changing slots; no branch was reset or deleted.`,
    );
  }
  await assertPrepareCommitsPublished(
    vars,
    branch,
    exec,
    defaultBranch,
    false,
    undefined,
    includeHead,
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
    throw prepareGitFailure(
      `Cannot verify unpublished commits on slot ${vars.slotId}; inspect Git refs before preparing or releasing it`,
      result,
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
  onPreserved?: (ref: string) => void,
  includeHead = true,
): Promise<void> {
  const refs = new Set<string>(includeHead ? ['HEAD'] : []);
  if (branch && (await localBranchExists(vars, branch, exec))) refs.add(`refs/heads/${branch}`);
  if (!refs.size) return;
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
  const probeRemotes = remotes.includes('origin')
    ? ['origin', ...remotes.filter((name) => name !== 'origin')]
    : remotes;
  const containingRefs = async (tip: string, roots: string[]) => {
    const result = await exec(
      vars,
      `${git} for-each-ref --contains=${shellQuote(tip)} --format='%(refname)' ${roots.map(shellQuote).join(' ')}`,
    );
    if (result.exitCode !== 0) throw prepareGitFailure('Cannot inspect backing Git refs', result);
    return result.stdout.trim().split(/\s+/).filter(Boolean);
  };
  const refreshed = new Set<string>();
  const protectedTips = new Set<string>();
  for (const ref of refs) {
    const tipResult = await exec(vars, `${git} rev-parse ${shellQuote(ref)}`);
    if (tipResult.exitCode !== 0) throw prepareGitFailure(`Cannot inspect ${ref}`, tipResult);
    const tip = tipResult.stdout.trim();
    if (protectedTips.has(tip)) continue;
    if (ref === 'HEAD' && !currentBranch) {
      // ADR-054 detaches parked work without moving its branch. Only refs that
      // this prepare cannot reset or delete may protect that detached tip.
      const local = await containingRefs(tip, ['refs/heads', 'refs/farmslot/preserved']);
      if (
        local.some(
          (name) =>
            name && name !== `refs/heads/${branch}` && name !== `refs/heads/${defaultBranch}`,
        )
      ) {
        protectedTips.add(tip);
        continue;
      }
    }
    const candidates = new Set<string>();
    for (const remote of probeRemotes)
      for (const name of [includeHead ? currentBranch : '', branch, defaultBranch])
        if (name) candidates.add(`refs/remotes/${remote}/${name}`);
    // Cached refs are candidate names only. They never count as publication
    // evidence until that exact ref has been refreshed, including narrow clones.
    for (const candidate of await containingRefs(tip, ['refs/remotes'])) candidates.add(candidate);
    let published = false;
    let firstFailure: Error | undefined;
    const probes = new Map<string, RemoteBranchProbe>();
    for (const candidate of candidates) {
      const remote = remotes.find((name) => candidate.startsWith(`refs/remotes/${name}/`));
      if (!remote) continue;
      const name = candidate.slice(`refs/remotes/${remote}/`.length);
      if (name === 'HEAD') continue;
      if (!refreshed.has(candidate)) {
        let exists = probes.get(remote);
        if (!exists) {
          const prefix = `refs/remotes/${remote}/`;
          const names = [...candidates]
            .filter((value) => value.startsWith(prefix))
            .map((value) => value.slice(prefix.length))
            .filter((value) => value !== 'HEAD');
          exists = await probeRemoteBranch(vars.remoteRepo, remote, names, (command) =>
            exec(vars, command),
          );
          probes.set(remote, exists);
        }
        if (exists.presence === 'unknown') {
          firstFailure ??= prepareGitFailure(
            `Cannot verify publication ref ${candidate}; current work preserved`,
            exists.result,
          );
          continue;
        }
        if (!exists.branches.includes(name)) {
          const prune = await exec(vars, `${git} update-ref -d ${shellQuote(candidate)}`);
          if (prune.exitCode !== 0)
            throw prepareGitFailure(`Cannot remove stale publication ref ${candidate}`, prune);
          continue;
        }
        // Fetch only possible backing refs. A full fetch on MetaMask's thousands
        // of branches can take minutes and is unnecessary for this proof.
        const fetch = await fetchRemoteBranch(vars.remoteRepo, remote, name, (command) =>
          exec(vars, command),
        );
        if (fetch.exitCode !== 0) {
          firstFailure ??= prepareGitFailure(
            `Cannot verify publication ref ${candidate}; current work preserved`,
            fetch,
          );
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
      // Retain until the operator publishes or explicitly discards these commits.
      onPreserved?.(preserved);
      console.log(
        `[prepare] preserved ${ref} at ${preserved} before refreshing the review workspace`,
      );
      protectedTips.add(tip);
      continue;
    }
    if (!published && firstFailure && !preserveUnpublished) throw firstFailure;
    if (!published)
      throw new Error(
        `Prepare refused on ${vars.slotId}: ${ref} has unpushed commits or an unverified tip (${tip.slice(0, 12)}). Push or preserve this branch before retrying; no branch was reset or deleted. To intentionally discard abandoned work, check out the slot's idle branch before deleting the abandoned branch with git branch -D <abandoned-branch>`,
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
  projectJson: RawProjectJson = {},
): Promise<string | null> {
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const dirty = await slotHasUserChanges(vars, projectJson, exec);
  const unpushed = (await findUnpushedSlotCommits(vars, 'HEAD', exec)).length > 0;
  // Edits in the working tree were never published anywhere: always keep them.
  if (dirty) return unpushed ? 'dirty files + unpushed commits' : 'dirty files';
  if (!unpushed) return null;
  // GitHub deletes a merged PR's branch, so commits whose branch is gone from
  // the remote the publish pushed to have nothing left to lose. Publication
  // runs `git push -u`, which records that remote as the branch's upstream;
  // push-remote config may name a different one and proves nothing. A remote
  // that cannot be asked proves nothing either, so the work stays protected.
  const remote = await exec(vars, `${git} config --get ${shellQuote(`branch.${branch}.remote`)}`);
  if (remote.exitCode !== 0 && remote.exitCode !== 1) return 'unpushed commits';
  const probe = await probeRemoteBranch(
    vars.remoteRepo,
    remote.stdout.trim() || 'origin',
    branch,
    (command) => exec(vars, command),
  );
  if (probe.presence === 'missing') {
    console.log(
      `[slot.release] ${vars.slotId}: remote branch '${branch}' deleted (merged) — allowing recycle`,
    );
    return null;
  }
  return 'unpushed commits';
}
