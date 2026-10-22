import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mock, test } from 'node:test';

import type { ReviewPublicationReceipt, Run } from '@farmslot/protocol';

import { makeRun } from '../run-completion/test-fixtures.js';

const gh = await import('../integrations/github-client.js');
const accounts = await import('../pr-monitoring/github-account.js');
const viewed = await import('./viewed-files.js');
const head = 'a'.repeat(40);
const run: Run = {
  ...makeRun({
    id: 'manual-post-run',
    flowType: 'review-pr',
    status: 'reconciling',
    ticketOrPr: 'example/app#42',
  }),
  createdByPrincipalId: 'owner',
  nativeOwnerPrincipalId: 'owner',
  reviewWorkspaceSubject: {
    repository: 'example/app',
    repositoryUrl: 'https://example.com/app.git',
    headSha: head,
    baseSha: 'b'.repeat(40),
    branch: 'reviewed',
    title: 'Source',
    body: '',
    capturedAt: new Date().toISOString(),
  },
  reviewResult: {
    recommendation: 'REQUEST_CHANGES',
    reviewMd: 'Pinned report.',
    reviewSnapshot: { source: 'github-pr', headSha: head, capturedAt: new Date().toISOString() },
    lineComments: [{ path: 'src/a.ts', line: 7, body: 'Preserve this check.', severity: 'major' }],
  },
};
const marker = `<!-- farmslot-review:${createHash('sha256')
  .update(JSON.stringify([run.id, 'owner', 'github.com', 'example/app', 42]))
  .digest('hex')} -->`;
const plain = `${run.reviewResult!.reviewMd}\n\n${marker}`;
const notice = `Reviewed head: \`${head}\`. The PR advanced to \`${'c'.repeat(40)}\` after this review; these findings concern the reviewed head.`;
let body = `${run.reviewResult!.reviewMd}\n\n${notice}\n\n${marker}`;
let commentBody = '**Major.** Preserve this check.';
let commentOwner = 'reviewer';
let available = true;
let receipt: ReviewPublicationReceipt | undefined;
let posts = 0;
let viewedWrites = 0;
mock.module('../integrations/github-client.js', {
  namedExports: {
    ...gh,
    ghRequest: async (args: string[]) => {
      if (args.includes('POST')) {
        posts++;
        throw new Error('Reconciliation must never POST');
      }
      const endpoint = args.find((arg) => arg.startsWith('repos/'));
      let value: unknown;
      if (endpoint?.endsWith('/reviews?per_page=100'))
        value = [
          available
            ? [
                {
                  id: 123,
                  body,
                  commit_id: head,
                  user: { login: 'reviewer' },
                  state: 'CHANGES_REQUESTED',
                  submitted_at: '2026-10-22T03:35:49Z',
                },
              ]
            : [],
        ];
      else if (endpoint?.endsWith('/reviews/123/comments?per_page=100')) value = [[{ id: 7 }]];
      else if (endpoint?.endsWith('/pulls/comments/7'))
        value = {
          id: 7,
          pull_request_review_id: 123,
          original_commit_id: head,
          path: 'src/a.ts',
          original_line: 7,
          side: 'RIGHT',
          body: commentBody,
          user: { login: commentOwner },
        };
      else if (endpoint?.endsWith('/pulls/42'))
        value = { user: { login: 'author' }, head: { sha: 'c'.repeat(40) } };
      else throw new Error(`Unexpected provider read: ${endpoint}`);
      return { stdout: JSON.stringify(value), stderr: '' };
    },
  },
});
mock.module('../pr-monitoring/github-account.js', {
  namedExports: {
    ...accounts,
    resolvePRSourceAccount: async () => ({
      host: 'github.com',
      token: 'fixture-only',
      scope: 'fixture',
    }),
  },
});
mock.module('./viewed-files.js', {
  namedExports: {
    ...viewed,
    markReviewedFilesViewed: async () => {
      viewedWrites++;
      return {
        headSha: head,
        attemptedAt: new Date().toISOString(),
        state: 'skipped',
        paths: [],
        markedPaths: [],
      };
    },
  },
});
const { publishWorkspaceReview } = await import('./provider.js');
const input = {
  run,
  ownerId: 'owner',
  account: { host: 'github.com', login: 'reviewer' },
  pr: { host: 'github.com', repo: 'example/app', number: 42 },
  authorize: async () => {},
  readReceipt: async () => undefined,
  saveReceipt: async (value: ReviewPublicationReceipt) => {
    receipt = value;
  },
  reconcileExisting: true,
};

test('explicit reconciliation adopts the exact old-head manual post while the run waits at its gate', async () => {
  const result = await publishWorkspaceReview(input);
  assert.equal(result.reviewId, 123);
  assert.equal(result.headSha, head);
  assert.equal(receipt?.state, 'published');
  assert.equal(posts, 0);
  body = plain;
  assert.equal((await publishWorkspaceReview(input)).state, 'published');
});

test('reconciliation rejects changed report, finding or account and cannot post from an unfinished run', async () => {
  for (const failure of ['body', 'comment', 'account', 'missing'] as const) {
    body = failure === 'body' ? `Altered report.\n\n${marker}` : plain;
    commentBody = failure === 'comment' ? 'Changed finding' : '**Major.** Preserve this check.';
    commentOwner = failure === 'account' ? 'foreign' : 'reviewer';
    available = failure !== 'missing';
    await assert.rejects(
      publishWorkspaceReview(input),
      failure === 'body'
        ? /body differs/
        : failure === 'missing'
          ? /complete before publication/
          : /inline findings/,
    );
  }
  assert.equal(posts, 0);
});

test('an exact unmarked manual review is registered once without posting or other provider mutations', async () => {
  body = run.reviewResult!.reviewMd;
  commentBody = run.reviewResult!.lineComments[0].body;
  commentOwner = 'reviewer';
  available = true;
  receipt = undefined;
  viewedWrites = 0;
  const failedRun: Run = { ...run, status: 'failed' };
  const adoption = { ...input, run: failedRun, readReceipt: async () => receipt };

  const result = await publishWorkspaceReview(adoption);
  assert.equal(result.reviewId, 123);
  assert.equal(result.bodySha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(result.state, 'published');
  assert.equal((await publishWorkspaceReview(adoption)).reviewId, 123);
  assert.equal(posts, 0);
  assert.equal(viewedWrites, 0);
  receipt = undefined;
  commentBody = 'A different finding';
  await assert.rejects(publishWorkspaceReview(adoption), /inline findings differ/);
  assert.equal(receipt, undefined);
  assert.equal(posts, 0);
});

test('a matching manual review blocks automatic posting until explicit reconciliation', async () => {
  body = run.reviewResult!.reviewMd;
  commentBody = run.reviewResult!.lineComments[0].body;
  commentOwner = 'reviewer';
  available = true;
  receipt = undefined;
  await assert.rejects(
    publishWorkspaceReview({
      ...input,
      run: { ...run, status: 'done' },
      reconcileExisting: false,
    }),
    /exists without a local attempted receipt/,
  );
  assert.equal(receipt, undefined);
  assert.equal(posts, 0);
});
