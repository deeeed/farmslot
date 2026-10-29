// methods/pr/review-comments.ts — native PR review thread and comment actions.

import {
  Methods,
  type PRAddCommentParams,
  type PRAddCommentResult,
  type PRDeleteCommentParams,
  type PRDeleteCommentResult,
  type PREditCommentParams,
  type PREditCommentResult,
  type PRResolveThreadParams,
  type PRResolveThreadResult,
  type PRReviewCommentsObservationParams,
  prReviewCommentsObservationParams,
  type PRReviewCommentsParams,
  type PRReviewCommentsResult,
  type PRReviewThread,
  type PRSubmitReviewParams,
  type PRSubmitReviewResult,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../../core/method-error.js';
import { ghRequest } from '../../integrations/github-client.js';
import { refreshPRStatusObservations } from '../pr.js';

import { PRDetailCollector, type PRDetailReadInterest } from './detail-collector.js';

interface GqlReviewComment {
  databaseId?: number;
  body?: string;
  author?: { login?: string };
  createdAt?: string;
  updatedAt?: string;
}

interface GqlReviewThread {
  id?: string;
  path?: string;
  line?: number | null;
  isResolved?: boolean;
  isOutdated?: boolean;
  comments?: { nodes?: GqlReviewComment[] };
}

// ─── PR Review Comments (already native) ───

let _cachedUser = '';
async function getCurrentUser(): Promise<string> {
  if (_cachedUser) return _cachedUser;
  try {
    const { stdout } = await ghRequest(['api', 'user', '--jq', '.login']);
    _cachedUser = stdout.trim();
  } catch {
    _cachedUser = '';
  }
  return _cachedUser;
}

type ReviewThreads = Omit<PRReviewCommentsResult, 'observation'>;

/** `strict` reads refuse an absent PR; released readers saw it as an empty thread list. */
async function queryReviewThreads(
  { pr, repo }: PRReviewCommentsObservationParams,
  strict: boolean,
): Promise<ReviewThreads> {
  const [owner, name] = repo.split('/');

  const query = `
    query($owner: String!, $name: String!, $pr: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $pr) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              comments(first: 50) {
                nodes {
                  databaseId
                  body
                  author { login }
                  createdAt
                  updatedAt
                }
              }
            }
          }
        }
      }
    }
  `;

  const { stdout } = await ghRequest(
    [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `pr=${pr}`,
    ],
    { caller: 'review-comments:threads' },
  );

  const data = JSON.parse(stdout) as {
    data?: {
      repository?: {
        pullRequest?: { reviewThreads?: { nodes?: GqlReviewThread[] } } | null;
      } | null;
    };
  };
  const pullRequest = data.data?.repository?.pullRequest;
  // An absent PR is an authorized not-found, never an empty thread list.
  if (!pullRequest && strict)
    throw new GatewayMethodError(
      data.data?.repository === undefined ? 'UPSTREAM_UNAVAILABLE' : 'NOT_FOUND',
      `GitHub returned no review threads for ${repo}#${pr}`,
    );
  const threadNodes: GqlReviewThread[] = pullRequest?.reviewThreads?.nodes ?? [];

  const threads: PRReviewThread[] = threadNodes.map((t) => ({
    id: t.id ?? '',
    path: t.path || '',
    line: t.line ?? null,
    resolved: t.isResolved ?? false,
    outdated: t.isOutdated ?? false,
    comments: (t.comments?.nodes ?? []).map((c) => ({
      id: c.databaseId ?? 0,
      body: c.body || '',
      author: c.author?.login || 'unknown',
      createdAt: c.createdAt || '',
      updatedAt: c.updatedAt || '',
    })),
  }));

  const currentUser = await getCurrentUser();
  return { threads, currentUser };
}

/** One shared review-thread observation per `{ pr, repo }`. */
export const prReviewThreadsObservation = new PRDetailCollector<
  PRReviewCommentsObservationParams,
  ReviewThreads
>({
  method: Methods.PR_REVIEW_COMMENTS,
  normalize: prReviewCommentsObservationParams,
  fetch: async (params) => ({ value: await queryReviewThreads(params, true) }),
});

/**
 * Readers without observer admission keep the released reply whenever the shared observation
 * cannot answer as current: an absent PR is an empty list and GitHub errors are the read's own.
 */
export async function prReviewComments(
  params: PRReviewCommentsParams,
  interest: PRDetailReadInterest = {},
): Promise<PRReviewCommentsResult> {
  const managed = interest.legacyInterest === false;
  try {
    const { value, observation } = await prReviewThreadsObservation.read(
      { pr: params.pr, repo: params.repo },
      interest,
    );
    if (managed || !observation.error) return { ...value, observation };
  } catch (error) {
    // GitHub transport and parse failures were already errors for every reader.
    if (managed || !(error instanceof GatewayMethodError)) throw error;
  }
  return queryReviewThreads({ pr: params.pr, repo: params.repo }, false);
}

/** A completed review command re-collects the observations it changed; it never waits for them. */
function reviewCommandCompleted(
  repo: string,
  pr: number | undefined,
  touches?: (thread: PRReviewThread) => boolean,
): void {
  const refreshed = prReviewThreadsObservation.refreshWhere(
    (params, value) =>
      params.repo.toLowerCase() === repo.toLowerCase() &&
      (params.pr === pr || (touches !== undefined && value?.threads.some(touches) === true)),
  );
  for (const target of new Set([...(pr === undefined ? [] : [pr]), ...refreshed.map((p) => p.pr)]))
    refreshPRStatusObservations(repo, target);
}

export async function prAddComment(params: PRAddCommentParams): Promise<PRAddCommentResult> {
  const { pr, repo, body, path, line, side, commitId, inReplyTo } = params;
  if (inReplyTo) {
    const { stdout } = await ghRequest(
      [
        'api',
        `repos/${repo}/pulls/${pr}/comments/${inReplyTo}/replies`,
        '-X',
        'POST',
        '-f',
        `body=${body}`,
      ],
      { force: true },
    );
    reviewCommandCompleted(repo, pr);
    return { id: JSON.parse(stdout).id };
  }
  if (commitId && !/^[0-9a-f]{40,64}$/i.test(commitId)) {
    throw new Error('commitId must be an exact commit SHA');
  }
  const resolvedCommitId = commitId
    ? commitId
    : (await ghRequest(['api', `repos/${repo}/pulls/${pr}`, '--jq', '.head.sha'])).stdout.trim();
  const { stdout } = await ghRequest(
    [
      'api',
      `repos/${repo}/pulls/${pr}/comments`,
      '-X',
      'POST',
      '-f',
      `body=${body}`,
      '-f',
      `path=${path}`,
      '-F',
      `line=${line}`,
      '-f',
      `side=${side || 'RIGHT'}`,
      '-f',
      `commit_id=${resolvedCommitId}`,
    ],
    { force: true },
  );
  reviewCommandCompleted(repo, pr);
  return { id: JSON.parse(stdout).id };
}

export async function prResolveThread(
  params: PRResolveThreadParams,
): Promise<PRResolveThreadResult> {
  const mutation = params.resolved
    ? 'mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { id } } }'
    : 'mutation($id: ID!) { unresolveReviewThread(input: {threadId: $id}) { thread { id } } }';
  await ghRequest(['api', 'graphql', '-f', `query=${mutation}`, '-f', `id=${params.threadId}`], {
    force: true,
    caller: 'review-comments:mutate',
  });
  reviewCommandCompleted(params.repo, undefined, (thread) => thread.id === params.threadId);
  return { ok: true };
}

export async function prEditComment(params: PREditCommentParams): Promise<PREditCommentResult> {
  await ghRequest(
    [
      'api',
      `repos/${params.repo}/pulls/comments/${params.commentId}`,
      '-X',
      'PATCH',
      '-f',
      `body=${params.body}`,
    ],
    { force: true },
  );
  reviewCommandCompleted(params.repo, undefined, (thread) =>
    thread.comments.some((comment) => comment.id === params.commentId),
  );
  return { ok: true };
}

export async function prDeleteComment(
  params: PRDeleteCommentParams,
): Promise<PRDeleteCommentResult> {
  await ghRequest(
    ['api', `repos/${params.repo}/pulls/comments/${params.commentId}`, '-X', 'DELETE'],
    { force: true },
  );
  reviewCommandCompleted(params.repo, undefined, (thread) =>
    thread.comments.some((comment) => comment.id === params.commentId),
  );
  return { ok: true };
}

export async function prSubmitReview(params: PRSubmitReviewParams): Promise<PRSubmitReviewResult> {
  const { stdout } = await ghRequest(
    [
      'api',
      `repos/${params.repo}/pulls/${params.pr}/reviews`,
      '-X',
      'POST',
      '-f',
      `body=${params.body}`,
      '-f',
      'event=COMMENT',
    ],
    { force: true },
  );
  reviewCommandCompleted(params.repo, params.pr);
  return { id: JSON.parse(stdout).id };
}
