import { DEFAULT_BRANCH } from '@farmslot/protocol';
import { isRecord } from '@farmslot/protocol/recipe';

import { execOnSlot, type RawProjectJson, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { hasUserSlotChanges } from '../../fleet/slot-scaffolding.js';
import { ghRequest } from '../../integrations/github-client.js';

interface UnpushedCommitOptions {
  preservedByLocalBranch?: boolean;
  patchBase?: string;
}

interface PrepareCommitPublicationOptions {
  headOnRemote?: boolean;
  defaultBranch?: string;
  githubRepo?: string;
}

export interface MergedPreparePullRequest {
  number: number;
  baseBranch: string;
  headSha: string;
  mergeSha: string;
}

type ReadMergedPreparePullRequests = (
  repo: string,
  headSha: string,
) => Promise<readonly MergedPreparePullRequest[]>;

const readMergedPreparePullRequests: ReadMergedPreparePullRequests = async (repo, headSha) => {
  const { stdout } = await ghRequest(
    ['api', `repos/${repo}/commits/${headSha}/pulls?per_page=100`],
    { force: true, caller: 'slot.prepare-publication', signal: AbortSignal.timeout(15_000) },
  );
  const data: unknown = JSON.parse(stdout);
  if (!Array.isArray(data))
    throw new Error('Cannot verify merged pull requests: expected an array');
  const merged: MergedPreparePullRequest[] = [];
  for (const pr of data) {
    if (!isRecord(pr) || !pr.merged_at) continue;
    if (
      !Number.isSafeInteger(pr.number) ||
      typeof pr.number !== 'number' ||
      pr.number < 1 ||
      !isRecord(pr.base) ||
      typeof pr.base.ref !== 'string' ||
      !isRecord(pr.head) ||
      typeof pr.head.sha !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(pr.head.sha) ||
      typeof pr.merge_commit_sha !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(pr.merge_commit_sha)
    )
      throw new Error('Cannot verify merged pull request identity');
    merged.push({
      number: pr.number,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      mergeSha: pr.merge_commit_sha,
    });
  }
  return merged;
};

async function refIncludedInMergedPullRequest(
  vars: SlotVars,
  ref: string,
  defaultBranch: string,
  repo: string,
  exec: typeof execOnSlot,
  readMerged: ReadMergedPreparePullRequests,
): Promise<boolean> {
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const head = await exec(vars, `${git} rev-parse --verify ${shellQuote(`${ref}^{commit}`)}`);
  if (head.exitCode !== 0) throw new Error(`Cannot verify ${ref}: ${head.stderr || head.stdout}`);
  for (const pr of await readMerged(repo, head.stdout.trim())) {
    if (pr.baseBranch !== defaultBranch) continue;
    const contained = await exec(
      vars,
      `${git} merge-base --is-ancestor ${shellQuote(pr.mergeSha)} ${shellQuote(`origin/${defaultBranch}`)}`,
    );
    if (contained.exitCode === 1) continue;
    if (contained.exitCode !== 0)
      throw new Error(
        `Cannot verify merged PR #${pr.number}: ${contained.stderr || contained.stdout}`,
      );
    const knownHead = await exec(
      vars,
      `${git} cat-file -e ${shellQuote(`${pr.headSha}^{commit}`)}`,
    );
    if (knownHead.exitCode !== 0) {
      // A later PR fix may have been pushed from another checkout before branch deletion.
      const fetched = await exec(
        vars,
        `${git} fetch --no-tags origin ${shellQuote(`refs/pull/${pr.number}/head`)}`,
      );
      if (fetched.exitCode !== 0)
        throw new Error(
          `Cannot fetch merged PR #${pr.number}: ${fetched.stderr || fetched.stdout}`,
        );
      const fetchedHead = await exec(vars, `${git} rev-parse --verify FETCH_HEAD`);
      if (fetchedHead.exitCode !== 0 || fetchedHead.stdout.trim() !== pr.headSha)
        throw new Error(`Cannot verify the retained head of merged PR #${pr.number}`);
    }
    const included = await exec(
      vars,
      `${git} merge-base --is-ancestor ${shellQuote(ref)} ${shellQuote(pr.headSha)}`,
    );
    if (included.exitCode === 0) return true;
    if (included.exitCode !== 1)
      throw new Error(
        `Cannot verify ${ref} in PR #${pr.number}: ${included.stderr || included.stdout}`,
      );
  }
  return false;
}

/** Commits not retained by remote refs or an allowed local branch. Git failures refuse. */
export async function findUnpushedSlotCommits(
  vars: SlotVars,
  ref = 'HEAD',
  exec: typeof execOnSlot = execOnSlot,
  options: UnpushedCommitOptions = {},
): Promise<string[]> {
  const result = await exec(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} log --format='%H %s'${options.patchBase ? '' : ' --max-count=5'} ${shellQuote(ref)} --not --remotes${options.preservedByLocalBranch ? ' --branches' : ''}`,
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Cannot verify commits on ${vars.slotId} at ${ref}: ${result.stderr || result.stdout}`,
    );
  const commits = result.stdout.trim().split('\n').filter(Boolean);
  if (!commits.length || !options.patchBase) return commits;
  const cherry = await exec(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} cherry ${shellQuote(options.patchBase)} ${shellQuote(ref)}`,
  );
  if (cherry.exitCode !== 0)
    throw new Error(
      `Cannot verify merged patches on ${vars.slotId}: ${cherry.stderr || cherry.stdout}`,
    );
  const merged = new Set(
    cherry.stdout
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2)),
  );
  // Filter before limiting the error details, so merged tips cannot hide older unpublished work.
  return commits.filter((line) => !merged.has(line.split(' ', 1)[0])).slice(0, 5);
}

/** Refuse before prepare can move HEAD or reset/delete the requested run branch. */
export async function assertPrepareCommitsPublished(
  vars: SlotVars,
  branch: string,
  exec: typeof execOnSlot = execOnSlot,
  // A detached HEAD prepare already resolved against the remote holds nothing to lose.
  options: PrepareCommitPublicationOptions = {},
  readMerged: ReadMergedPreparePullRequests = readMergedPreparePullRequests,
): Promise<void> {
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const defaultBranch = options.defaultBranch ?? DEFAULT_BRANCH;
  // Keep last-published tips reachable after upstream deletion/squash merge.
  // Already-pruned squash merges are verified by patch or merged-PR identity below.
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
  const refs = options.headOnRemote ? [] : ['HEAD'];
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
    const commits = await findUnpushedSlotCommits(vars, ref, exec, {
      preservedByLocalBranch: ref === 'HEAD' && head.exitCode === 1,
      patchBase: `origin/${defaultBranch}`,
    });
    if (
      commits.length &&
      options.githubRepo &&
      (await refIncludedInMergedPullRequest(
        vars,
        ref,
        defaultBranch,
        options.githubRepo,
        exec,
        readMerged,
      ))
    )
      continue;
    if (commits.length)
      throw new Error(
        `Prepare refused on ${vars.slotId}: ${ref} has unpushed commits: ${commits.join('; ')}. Push or preserve them before retrying; no branch was reset or deleted.`,
      );
  }
}

/** Only replace a published branch after all its commits reach an allowed base. */
export async function assertPublishedPrepareBranchContained(
  vars: SlotVars,
  branch: string,
  allowedBases: readonly string[],
  exec: typeof execOnSlot = execOnSlot,
): Promise<void> {
  const result = await exec(
    vars,
    `git -C ${shellQuote(vars.remoteRepo)} log --oneline --max-count=5 ${shellQuote(`refs/remotes/origin/${branch}`)} --not ${allowedBases.map(shellQuote).join(' ')}`,
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Cannot verify published branch ${branch}; prepare left branches untouched. ${result.stderr || result.stdout}`,
    );
  const commits = result.stdout.trim();
  if (commits)
    throw new Error(
      `Prepare refused to replace published branch ${branch}: unique commits not contained in ${allowedBases.join(' or ')}: ${commits.replaceAll('\n', '; ')}. No local or remote branch was deleted.`,
    );
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
