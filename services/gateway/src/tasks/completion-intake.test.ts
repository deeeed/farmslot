import assert from 'node:assert/strict';
import test from 'node:test';

import type { ghRequest } from '../integrations/github-client.js';
import { makeRun } from '../run-engine/test-fixtures.js';

import {
  fetchPRCompletionIntake,
  inheritedPRCompletionAcceptance,
  originalPRCompletionCriteria,
} from './completion-intake.js';

await import('../runtime/mock-pty.test-support.js');
const { completionCommentRows, renderCommentSummary } = await import('./writer.js');

function threadPage(commentsComplete = true): string {
  return JSON.stringify({
    headRefOid: 'a'.repeat(40),
    reviewThreads: {
      nodes: [
        {
          id: 'thread-1',
          isResolved: false,
          comments: {
            pageInfo: { hasNextPage: !commentsComplete },
            nodes: [
              {
                id: 'comment-1',
                body: 'Fix this. '.repeat(100),
                author: { login: 'cursor[bot]' },
                url: 'https://example.test/comments/1',
                updatedAt: '2026-10-25T00:00:00Z',
              },
            ],
          },
        },
      ],
    },
  });
}

test('one intake retains full review bodies and bot/human sources without filtering', async () => {
  const calls: string[][] = [];
  const request: typeof ghRequest = async (args) => {
    calls.push(args);
    const stdout = args.includes('graphql')
      ? threadPage()
      : JSON.stringify({
          id: args.some((arg) => arg.includes('/reviews')) ? 3 : 2,
          body: 'A human obligation',
          author: 'person',
          url: 'https://example.test/comments/2',
          updatedAt: '2026-10-25T00:00:00Z',
        });
    return { stdout, stderr: '' };
  };
  const intake = await fetchPRCompletionIntake('example/repo', 7, request);
  assert.equal(intake.sources.length, 3);
  assert.equal(intake.sources[0].body.length, 1000);
  assert.equal(intake.sources[0].author, 'cursor[bot]');
  assert.equal(intake.sources[0].resolved, false);
  assert.equal(intake.identity.headSha, 'a'.repeat(40));
  assert.ok(calls.every((args) => args.includes('--paginate')));
});

test('a failed or incomplete fetch refuses instead of returning an empty intake', async () => {
  const failed: typeof ghRequest = async () => {
    throw new Error('Provider unavailable');
  };
  await assert.rejects(fetchPRCompletionIntake('example/repo', 7, failed), /Provider unavailable/);
  const incomplete: typeof ghRequest = async (args) => ({
    stdout: args.includes('graphql') ? threadPage(false) : '',
    stderr: '',
  });
  await assert.rejects(
    fetchPRCompletionIntake('example/repo', 7, incomplete),
    /incomplete comment connection/,
  );
  const empty: typeof ghRequest = async () => ({ stdout: '', stderr: '' });
  await assert.rejects(fetchPRCompletionIntake('example/repo', 7, empty), /no PR snapshot/);
});

test('original acceptance defaults to the parent, including an explicitly empty registration', async () => {
  const ticketData = {
    source: 'manual' as const,
    title: 'Original',
    description: 'Original',
    acceptanceCriteria: ['Ticket AC'],
    affectedArea: '',
    stepsToReproduce: [],
    screenshots: [],
    labels: [],
  };
  const run = makeRun({ parentRunId: 'parent', flowType: 'pr-complete', ticketData });
  const parent = makeRun({
    id: 'parent',
    ticketData: { ...ticketData, acceptanceCriteria: ['Parent AC'] },
  });
  assert.deepEqual(await originalPRCompletionCriteria(run, async () => parent), [
    { id: 'AC-1', text: 'Parent AC' },
  ]);
  assert.deepEqual(
    await originalPRCompletionCriteria(run, async () => ({
      ...parent,
      ticketData: { ...ticketData, acceptanceCriteria: [] },
    })),
    [],
  );
  await assert.rejects(
    originalPRCompletionCriteria(run, async () => undefined),
    /parent.*unavailable/,
  );
  assert.deepEqual(await originalPRCompletionCriteria({ ...run, parentRunId: null }), [
    { id: 'AC-1', text: 'Ticket AC' },
  ]);
});

test('resolved threads and deleted authors keep comment IDs and file context', async () => {
  const page = JSON.parse(threadPage());
  const thread = page.reviewThreads.nodes[0];
  thread.isResolved = true;
  Object.assign(thread.comments.nodes[0], {
    author: null,
    databaseId: 17,
    path: 'src/example.ts',
    line: 42,
  });
  const intake = await fetchPRCompletionIntake('example/repo', 7, async (args) => ({
    stdout: args.includes('graphql') ? JSON.stringify(page) : '',
    stderr: '',
  }));
  assert.deepEqual(
    {
      threadId: intake.sources[0].threadId,
      commentId: intake.sources[0].commentId,
      databaseId: intake.sources[0].databaseId,
      author: intake.sources[0].author,
      path: intake.sources[0].path,
      line: intake.sources[0].line,
      resolved: intake.sources[0].resolved,
    },
    {
      threadId: 'thread-1',
      commentId: 'comment-1',
      databaseId: 17,
      author: undefined,
      path: 'src/example.ts',
      line: 42,
      resolved: true,
    },
  );
});

test('pending unsubmitted reviews are excluded before requiring a submission timestamp', async () => {
  const intake = await fetchPRCompletionIntake('example/repo', 7, async (args) => ({
    stdout: args.includes('graphql')
      ? threadPage()
      : args.some((arg) => arg.includes('/reviews'))
        ? JSON.stringify({
            id: 19,
            body: 'Private draft',
            state: 'PENDING',
            updatedAt: null,
            author: 'person',
            url: 'https://example.test/review/19',
          })
        : '',
    stderr: '',
  }));
  assert.equal(intake.sources.length, 1);
  assert.equal(intake.sources[0].providerKind, 'thread');
  assert.ok(!intake.sources.some(({ body }) => body === 'Private draft'));
});

test('completion comment previews keep conversation and review-summary reply identities separate', async () => {
  const { initializeAcceptanceRegistration } = await import('./acceptance-registration.js');
  const { completionCommentSource } = await import('./completion-intake.js');
  const row = {
    id: 1,
    body: 'Fix this',
    updatedAt: '2026-10-25T00:00:00Z',
    author: 'person',
    url: 'https://example.test/comment/1',
  };
  const registration = initializeAcceptanceRegistration(
    'run',
    [],
    [
      completionCommentSource('example/repo', 7, 'issue', row),
      completionCommentSource('example/repo', 7, 'review', { ...row, id: 2 }),
    ],
    {
      provider: 'github',
      repository: 'example/repo',
      prNumber: 7,
      headSha: 'a'.repeat(40),
      capturedAt: row.updatedAt,
    },
  );
  const rows = completionCommentRows(registration);
  assert.equal(rows[0].source, 'issue');
  assert.equal(rows[0].id, 1);
  assert.equal(rows[1].source, 'review-summary');
  assert.equal(rows[1].id, undefined);
  assert.equal(rows[1].reviewId, '2');
  assert.match(renderCommentSummary(rows), /review-summary.*review 2/);
});

test("the dispatch preview names the parent's original criteria a pr-complete run inherits (F286)", async () => {
  // 9f0b6812: a CI-fix pr-complete was held to family 8a768552's AC1-AC4 without the preview saying so.
  const parent = makeRun({
    id: 'family-parent',
    project: 'echobridge',
    ticketData: {
      source: 'manual',
      title: 'Dependency update',
      description: '',
      affectedArea: '',
      acceptanceCriteria: [
        'Every direct dependency is on its latest stable version.',
        'Tests pass.',
      ],
      stepsToReproduce: [],
      screenshots: [],
      labels: [],
    },
  });
  const inherited = await inheritedPRCompletionAcceptance(
    'family-parent',
    'echobridge',
    async (id) => (id === parent.id ? parent : undefined),
  );
  assert.equal(inherited.fromRunId, 'family-parent');
  assert.deepEqual(
    inherited.criteria.map(({ text }) => text),
    ['Every direct dependency is on its latest stable version.', 'Tests pass.'],
  );
  assert.equal(inherited.unavailable, undefined);
  // A parent that can't be read is named, not dropped: the task writer would refuse it.
  const missing = await inheritedPRCompletionAcceptance(
    'gone',
    'echobridge',
    async () => undefined,
  );
  assert.deepEqual(missing.criteria, []);
  assert.match(missing.unavailable ?? '', /original parent acceptance registration is unavailable/);
});
