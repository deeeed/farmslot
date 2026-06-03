// methods/pr/review-comments.ts — native PR review thread and comment actions.

import type {
  PRAddCommentParams,
  PRAddCommentResult,
  PRDeleteCommentParams,
  PRDeleteCommentResult,
  PREditCommentParams,
  PREditCommentResult,
  PRResolveThreadParams,
  PRResolveThreadResult,
  PRReviewCommentsParams,
  PRReviewCommentsResult,
  PRReviewThread,
  PRSubmitReviewParams,
  PRSubmitReviewResult,
} from '@farmslot/protocol';

import { ghRequest } from '../../integrations/github-client.js';

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

export async function prReviewComments(
  params: PRReviewCommentsParams,
): Promise<PRReviewCommentsResult> {
  const { pr, repo } = params;
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

  const { stdout } = await ghRequest([
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
  ]);

  const data = JSON.parse(stdout) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: GqlReviewThread[] } } } };
  };
  const threadNodes: GqlReviewThread[] =
    data.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];

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

export async function prAddComment(params: PRAddCommentParams): Promise<PRAddCommentResult> {
  const { pr, repo, body, path, line, side, inReplyTo } = params;
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
    return { id: JSON.parse(stdout).id };
  }
  const { stdout: shaOut } = await ghRequest([
    'api',
    `repos/${repo}/pulls/${pr}`,
    '--jq',
    '.head.sha',
  ]);
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
      `commit_id=${shaOut.trim()}`,
    ],
    { force: true },
  );
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
  });
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
  return { ok: true };
}

export async function prDeleteComment(
  params: PRDeleteCommentParams,
): Promise<PRDeleteCommentResult> {
  await ghRequest(
    ['api', `repos/${params.repo}/pulls/comments/${params.commentId}`, '-X', 'DELETE'],
    { force: true },
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
  return { id: JSON.parse(stdout).id };
}
