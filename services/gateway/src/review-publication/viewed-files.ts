import type {
  MonitoredPRIdentity,
  PRSourceAccount,
  ReviewViewedFilesResult,
} from '@farmslot/protocol';

import { ghRequest } from '../integrations/github-client.js';
import {
  collectGitHubPages,
  githubGraphQL,
  type GitHubPage,
  type GitHubQueryAccount,
  withGitHubQueryDeadline,
} from '../integrations/github-graphql.js';

interface ViewedFilesInput {
  pr: MonitoredPRIdentity;
  headSha: string;
  account: PRSourceAccount;
  binding: GitHubQueryAccount;
}

interface PullRequestFiles {
  id: string;
  headRefOid: string;
  baseRefOid: string;
  changedFiles: number;
  files: GitHubPage<{ path: string }>;
}

interface FilesQuery {
  viewer: { login: string };
  repository: { pullRequest: PullRequestFiles | null } | null;
}

const fileQuery = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id headRefOid baseRefOid changedFiles
      files(first: 100, after: $cursor) { nodes { path } pageInfo { hasNextPage endCursor } }
    }
  }
}`;

/** GitHub has no commit-CAS for Viewed. Fence each batch and record observed races. */
export async function markReviewedFilesViewed(
  input: ViewedFilesInput,
  save: (result: ReviewViewedFilesResult) => Promise<void>,
): Promise<ReviewViewedFilesResult> {
  const result = await attemptViewedFiles(input);
  return retainViewedFilesResult(result, save);
}

export async function retainViewedFilesResult(
  result: ReviewViewedFilesResult,
  save: (result: ReviewViewedFilesResult) => Promise<void>,
): Promise<ReviewViewedFilesResult> {
  try {
    await save(result);
  } catch {
    // Publication is already durable. A diagnostic write cannot undo or fail it.
    result.reason = [result.reason, 'Viewed result could not be retained']
      .filter(Boolean)
      .join('; ');
    console.warn('[review-publication] Viewed result could not be retained');
  }
  return result;
}

async function attemptViewedFiles(input: ViewedFilesInput): Promise<ReviewViewedFilesResult> {
  const result: ReviewViewedFilesResult = {
    headSha: input.headSha,
    account: structuredClone(input.account),
    attemptedAt: new Date().toISOString(),
    state: 'skipped',
    paths: [],
    markedPaths: [],
  };
  const signal = AbortSignal.timeout(8000);
  try {
    return await withGitHubQueryDeadline(8000, async () => {
      const [owner, name] = input.pr.repo.split('/');
      let prId = '';
      let changedFiles = 0;
      let observedBase: string | undefined;
      const assertHead = (pr: { headRefOid: string; baseRefOid: string } | null | undefined) => {
        if (pr?.headRefOid !== input.headSha || (observedBase && pr.baseRefOid !== observedBase))
          throw new Error('PR head or base changed since the review; Viewed marking stopped');
      };
      const files = await collectGitHubPages(async (cursor) => {
        const data = await githubGraphQL<FilesQuery>(
          fileQuery,
          { owner, name, number: input.pr.number, cursor },
          input.binding,
        );
        if (data.viewer?.login?.toLowerCase() !== input.account.login.toLowerCase())
          throw new Error('Viewed marking account differs from the publication account');
        const pr = data.repository?.pullRequest;
        assertHead(pr);
        if (!pr?.id || (prId && pr.id !== prId) || !Number.isSafeInteger(pr.changedFiles))
          throw new Error('GitHub returned an incomplete reviewed diff');
        prId = pr.id;
        observedBase ??= pr.baseRefOid;
        changedFiles = pr.changedFiles;
        return pr.files;
      });
      if (files.some((file) => typeof file.path !== 'string' || !file.path))
        throw new Error('GitHub returned an invalid reviewed file path');
      result.paths = [...new Set(files.map((file) => file.path))];
      if (result.paths.length !== changedFiles)
        throw new Error('GitHub returned an incomplete reviewed file list');
      for (let start = 0; start < result.paths.length; start += 20) {
        const current = await githubGraphQL<{ node: PullRequestFiles | null }>(
          'query($id: ID!) { node(id: $id) { ... on PullRequest { headRefOid baseRefOid } } }',
          { id: prId },
          input.binding,
        );
        assertHead(current.node);
        const batch = result.paths.slice(start, start + 20);
        const declarations = batch.map((_, i) => `$path${i}: String!`).join(', ');
        const mutations = batch
          .map(
            (_, i) =>
              `file${i}: markFileAsViewed(input: { pullRequestId: $id, path: $path${i}, clientMutationId: $head }) { pullRequest { id headRefOid baseRefOid } }`,
          )
          .join('\n');
        const args = [
          'api',
          '--hostname',
          input.pr.host,
          'graphql',
          '-f',
          `query=mutation($id: ID!, $head: String!, ${declarations}) { ${mutations} }`,
          '-f',
          `id=${prId}`,
          '-f',
          `head=${input.headSha}`,
          ...batch.flatMap((file, i) => ['-f', `path${i}=${file}`]),
        ];
        const { stdout } = await ghRequest(args, { account: input.binding, signal });
        const response: {
          data?: Record<string, { pullRequest?: PullRequestFiles }>;
          errors?: { message: string }[];
        } = JSON.parse(stdout);
        let unconfirmed = false;
        for (const [i, file] of batch.entries()) {
          const pr = response.data?.[`file${i}`]?.pullRequest;
          if (!pr) {
            unconfirmed = true;
            continue;
          }
          assertHead(pr);
          if (pr?.id !== prId) throw new Error('GitHub did not confirm the Viewed mutation');
          result.markedPaths.push(file);
        }
        if (response.errors?.length)
          throw new Error(response.errors.map((error) => error.message).join('; '));
        if (unconfirmed) throw new Error('GitHub did not confirm every Viewed mutation');
      }
      result.state = 'complete';
      return result;
    });
  } catch (error) {
    // Viewed state is a display convenience. Provider failure must preserve publication.
    result.state = result.markedPaths.length ? 'partial' : 'failed';
    result.reason = error instanceof Error ? error.message : String(error);
    return result;
  }
}
