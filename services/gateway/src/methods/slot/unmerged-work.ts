import { isRecord } from '@farmslot/protocol/recipe';

import { withFarmGitConfig } from '../../core/farm-git.js';
import { execOnSlot, type SlotVars } from '../../core/index.js';
import { shellQuote } from '../../core/tmux.js';
import { github } from '../../integrations/github-client.js';

export interface MergedPreparePullRequest {
  number: number;
  baseBranch: string;
  headSha: string;
  mergeSha: string;
}

type ReadMergedPreparePullRequests = (
  repo: string,
  headSha: string,
  timeoutMs?: number,
  force?: boolean,
  headBranch?: string,
) => Promise<readonly MergedPreparePullRequest[]>;

export const readMergedPreparePullRequests: ReadMergedPreparePullRequests = async (
  repo,
  headSha,
  timeoutMs = 15_000,
  force = true,
  headBranch,
) => {
  const endpoint = headBranch
    ? `repos/${repo}/pulls?state=closed&head=${encodeURIComponent(`${repo.split('/')[0]}:${headBranch}`)}&per_page=100`
    : `repos/${repo}/commits/${headSha}/pulls?per_page=100`;
  const data: unknown = await github.rest<unknown>('GET', endpoint, {
    force,
    caller: 'slot.prepare-publication',
    signal: AbortSignal.timeout(timeoutMs),
  });
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
    if (
      headBranch &&
      (pr.state !== 'closed' ||
        pr.head.ref !== headBranch ||
        !isRecord(pr.head.repo) ||
        typeof pr.head.repo.full_name !== 'string' ||
        pr.head.repo.full_name.toLowerCase() !== repo.toLowerCase())
    )
      continue;
    merged.push({
      number: pr.number,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      mergeSha: pr.merge_commit_sha,
    });
  }
  return merged;
};

type PublishedAncestryReader = (
  repo: string,
  base: string,
  head: string,
  timeoutMs: number,
) => Promise<boolean>;
interface MergedPullRequestReadOptions {
  allowFetch?: boolean;
  timeoutMs?: number;
  defaultSha?: string;
  readAncestry?: PublishedAncestryReader;
}

const readPublishedAncestry: PublishedAncestryReader = async (repo, base, head, timeoutMs) => {
  const data: unknown = await github.rest<unknown>(
    'GET',
    `repos/${repo}/compare/${base}...${head}`,
    {
      caller: 'slot.publication-coverage',
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!isRecord(data) || !isRecord(data.base_commit) || !isRecord(data.merge_base_commit))
    throw new Error('Cannot verify published ancestry');
  return (
    (data.status === 'ahead' || data.status === 'identical') &&
    data.base_commit.sha === base &&
    data.merge_base_commit.sha === base
  );
};

const passiveAncestry = new Map<string, Promise<boolean>>();

/** Published SHA ancestry is immutable. Fetch-enabled recovery checks still use a fresh provider read. */
const readPassivePublishedAncestry: PublishedAncestryReader = (repo, base, head, timeoutMs) => {
  if (![base, head].every((sha) => /^[a-f0-9]{40,64}$/i.test(sha)))
    return readPublishedAncestry(repo, base, head, timeoutMs);
  const key = JSON.stringify([repo, base, head]);
  const cached = passiveAncestry.get(key);
  if (cached) return cached;
  const read = readPublishedAncestry(repo, base, head, timeoutMs).catch((error: unknown) => {
    if (passiveAncestry.get(key) === read) passiveAncestry.delete(key);
    throw error;
  });
  passiveAncestry.set(key, read);
  if (passiveAncestry.size > 512) {
    const oldest = passiveAncestry.keys().next().value;
    if (oldest !== undefined) passiveAncestry.delete(oldest);
  }
  return read;
};

export async function refIncludedInMergedPullRequest(
  vars: SlotVars,
  ref: string,
  defaultBranch: string,
  repo: string,
  exec: typeof execOnSlot,
  readMerged: ReadMergedPreparePullRequests,
  options: MergedPullRequestReadOptions = {},
): Promise<boolean> {
  const readAncestry =
    options.readAncestry ??
    (options.allowFetch === false ? readPassivePublishedAncestry : readPublishedAncestry);
  const read = (command: string) =>
    exec(
      vars,
      withFarmGitConfig(command),
      options.timeoutMs ? { timeout: options.timeoutMs } : undefined,
    );
  const git = `git -C ${shellQuote(vars.remoteRepo)}`;
  const head = await read(`${git} rev-parse --verify ${shellQuote(`${ref}^{commit}`)}`);
  if (head.exitCode !== 0) throw new Error(`Cannot verify ${ref}: ${head.stderr || head.stdout}`);
  for (const pr of await readMerged(repo, head.stdout.trim())) {
    if (pr.baseBranch !== defaultBranch) continue;
    const contained = await read(
      `${git} merge-base --is-ancestor ${shellQuote(pr.mergeSha)} ${shellQuote(options.defaultSha ?? `origin/${defaultBranch}`)}`,
    );
    if (contained.exitCode !== 0 && options.defaultSha) {
      if (!(await readAncestry(repo, pr.mergeSha, options.defaultSha, options.timeoutMs ?? 5000)))
        continue;
    } else {
      if (contained.exitCode === 1) continue;
      if (contained.exitCode !== 0)
        throw new Error(
          `Cannot verify merged PR #${pr.number}: ${contained.stderr || contained.stdout}`,
        );
    }
    if (pr.headSha === head.stdout.trim()) return true;
    const knownHead = await read(`${git} cat-file -e ${shellQuote(`${pr.headSha}^{commit}`)}`);
    if (knownHead.exitCode !== 0 && options.allowFetch === false) {
      // Status reads cannot fetch a later PR head. Compare the two published
      // identities on GitHub while retaining the local merged-default check.
      if (await readAncestry(repo, head.stdout.trim(), pr.headSha, options.timeoutMs ?? 5000))
        return true;
      continue;
    }
    if (knownHead.exitCode !== 0) {
      // A later PR fix may have been pushed from another checkout before branch deletion.
      const fetched = await exec(
        vars,
        withFarmGitConfig(
          `${git} fetch --no-tags origin ${shellQuote(`refs/pull/${pr.number}/head`)}`,
        ),
      );
      if (fetched.exitCode !== 0)
        throw new Error(
          `Cannot fetch merged PR #${pr.number}: ${fetched.stderr || fetched.stdout}`,
        );
      const fetchedHead = await exec(
        vars,
        withFarmGitConfig(`${git} rev-parse --verify FETCH_HEAD`),
      );
      if (fetchedHead.exitCode !== 0 || fetchedHead.stdout.trim() !== pr.headSha)
        throw new Error(`Cannot verify the retained head of merged PR #${pr.number}`);
    }
    const included = await read(
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

/** Only replace a published branch after all its commits reach an allowed base. */
export async function assertPublishedPrepareBranchContained(
  vars: SlotVars,
  branch: string,
  allowedBases: readonly string[],
  exec: typeof execOnSlot = execOnSlot,
): Promise<void> {
  const result = await exec(
    vars,
    withFarmGitConfig(
      `git -C ${shellQuote(vars.remoteRepo)} log --oneline --max-count=5 ${shellQuote(`refs/remotes/origin/${branch}`)} --not ${allowedBases.map(shellQuote).join(' ')}`,
    ),
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
