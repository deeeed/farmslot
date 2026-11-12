import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';

import {
  githubQueryBudget,
  GitHubQueryBudgetError,
} from '../../integrations/github-query-budget.js';

import type { PRRawSnapshot } from './raw-cache.js';

const READS = [
  'pr.checks',
  'pr.view',
  'issues.comments',
  'pulls.reviewThreads',
  'pulls.commits',
  'pr.reviews',
] as const;
type Read = (typeof READS)[number];

interface FakeState {
  issueComments: number;
  reviewThreads: number;
  failing?: Read;
  failure: () => Error;
}
const state: FakeState = {
  issueComments: 1,
  reviewThreads: 1,
  failure: () => new Error('HTTP 502: Bad Gateway'),
};
const calls: Read[] = [];

function answer<T>(read: Read, value: T): T {
  calls.push(read);
  if (state.failing === read) throw state.failure();
  return value;
}

function issueComment(i: number) {
  return {
    id: 1000 + i,
    user: { login: i === 0 ? 'cursor[bot]' : `user${i}`, type: i === 0 ? 'Bot' : 'User' },
    body: i === 0 ? 'x'.repeat(400) : `comment ${i}`,
    created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    html_url: `https://github.com/org/app/pull/7#issuecomment-${1000 + i}`,
  };
}

function reviewThread(i: number, flags: { isResolved: boolean; isOutdated: boolean }) {
  return {
    ...flags,
    comments: {
      nodes: [
        {
          databaseId: 5000 + i,
          author:
            i === 0
              ? { login: 'cursor', __typename: 'Bot' }
              : { login: `r${i}`, __typename: 'User' },
          body: `finding ${i}`,
          path: 'src/a.ts',
          line: i === 0 ? null : i,
          createdAt: '2026-01-02T00:00:00Z',
          url: `https://github.com/org/app/pull/7#discussion_r${5000 + i}`,
          replyTo: i === 1 ? { databaseId: 5000 } : null,
        },
      ],
    },
  };
}

/** Unresolved threads plus one resolved and one outdated thread, served 100 per page. */
function threadPage(cursor: string | null) {
  const threads = [
    ...Array.from({ length: state.reviewThreads }, (_, i) =>
      reviewThread(i, { isResolved: false, isOutdated: false }),
    ),
    reviewThread(9001, { isResolved: true, isOutdated: false }),
    reviewThread(9002, { isResolved: false, isOutdated: true }),
  ];
  const start = cursor ? Number(cursor) : 0;
  const end = Math.min(start + 100, threads.length);
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: threads.slice(start, end),
          pageInfo: { hasNextPage: end < threads.length, endCursor: String(end) },
        },
      },
    },
  };
}

const clientModule = await import('../../integrations/github-client.js');
const fakeGithub = {
  ...clientModule.github,
  prChecks: async () =>
    answer('pr.checks', [
      {
        name: 'unit\ttests',
        bucket: 'pass',
        startedAt: '2026-01-01T00:00:00Z',
        completedAt: '2026-01-01T00:01:00Z',
        state: 'SUCCESS',
        link: 'https://ci/1',
      },
    ]),
  prView: async () =>
    answer('pr.view', {
      state: 'OPEN',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      reviewDecision: 'APPROVED',
      headRefName: 'feat/a',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      closedAt: null,
      mergedAt: null,
      title: 'Fix\tthe thing',
      author: { login: 'octocat' },
    }),
  rest: async (_method: string, path: string, opts?: { paginate?: boolean }) => {
    if (path.endsWith('/commits'))
      return answer('pulls.commits', [
        { commit: { committer: { date: '2026-01-03T00:00:00Z' } } },
        { commit: { committer: { date: '2026-01-04T00:00:00Z' } } },
      ]);
    const comments = Array.from({ length: state.issueComments }, (_, i) => issueComment(i));
    // Without pagination GitHub answers the first page only.
    return answer('issues.comments', opts?.paginate ? comments : comments.slice(0, 30));
  },
  graphql: async (_doc: string, vars: Record<string, string | number | null>) => {
    if ('endCursor' in vars)
      return answer(
        'pulls.reviewThreads',
        threadPage(typeof vars.endCursor === 'string' ? vars.endCursor : null),
      );
    return answer('pr.reviews', {
      repository: {
        pullRequest: {
          latestOpinionatedReviews: {
            nodes: [{ author: { login: 'lead' }, state: 'APPROVED', submittedAt: '2026-01-02' }],
          },
          reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'Team', slug: 'core' } }] },
        },
      },
    });
  },
};
mock.module('../../integrations/github-client.js', {
  namedExports: { ...clientModule, github: fakeGithub },
});
const { getPRRawData } = await import('./raw-cache.js');

afterEach(() => {
  state.issueComments = 1;
  state.reviewThreads = 1;
  state.failing = undefined;
  state.failure = () => new Error('HTTP 502: Bad Gateway');
  githubQueryBudget.resetForTests();
});

function withoutFetchTime({ fetchedAt: _fetchedAt, ...raw }: PRRawSnapshot) {
  return raw;
}

test('a PR with 120 issue comments and 150 unresolved review threads keeps all of them in the gh line format', async () => {
  state.issueComments = 120;
  state.reviewThreads = 150;
  const raw = await getPRRawData('org/app', 7, true);

  const comments = raw.commentsStdout.split('\n');
  assert.equal(comments.pop(), '', 'every line ends with a newline');
  assert.equal(comments.length, 120);
  assert.equal(
    comments[0],
    `{"id":1000,"author":"cursor[bot]","user_type":"Bot","body":"${'x'.repeat(300)}","created_at":"2026-01-01T00:00:00Z","html_url":"https://github.com/org/app/pull/7#issuecomment-1000"}`,
  );
  assert.equal(JSON.parse(comments[119] ?? '').id, 1119);

  const threads = raw.reviewCommentsStdout.split('\n');
  assert.equal(threads.pop(), '');
  assert.equal(threads.length, 150, 'resolved and outdated threads are left out');
  assert.equal(
    threads[0],
    '{"id":5000,"author":"cursor[bot]","user_type":"Bot","body":"finding 0","path":"src/a.ts","line":null,"created_at":"2026-01-02T00:00:00Z","in_reply_to_id":null,"html_url":"https://github.com/org/app/pull/7#discussion_r5000"}',
  );
  assert.equal(
    threads[1],
    '{"id":5001,"author":"r1","user_type":"User","body":"finding 1","path":"src/a.ts","line":1,"created_at":"2026-01-02T00:00:00Z","in_reply_to_id":5000,"html_url":"https://github.com/org/app/pull/7#discussion_r5001"}',
  );
  assert.equal(JSON.parse(threads[149] ?? '').id, 5149);

  assert.equal(
    raw.checksStdout,
    'unit\\ttests\tpass\t2026-01-01T00:00:00Z\t2026-01-01T00:01:00Z\tSUCCESS\thttps://ci/1\n',
  );
  assert.equal(raw.checksAvailable, true);
  assert.equal(
    raw.prStateStdout,
    'OPEN\tMERGEABLE\tCLEAN\tAPPROVED\tfeat/a\t2026-01-01T00:00:00Z\t2026-01-02T00:00:00Z\t\t\tFix\\tthe thing',
  );
  assert.equal(raw.prStateError, undefined);
  assert.equal(raw.author, 'octocat');
  assert.equal(raw.latestCommitStdout, '2026-01-04T00:00:00Z\n');
  assert.equal(
    raw.reviewMetaStdout,
    '{"t":"review","author":"lead","state":"APPROVED","submittedAt":"2026-01-02"}\n{"t":"request","kind":"team","name":"core"}\n',
  );
  assert.deepEqual(raw.errors, []);
  assert.equal(raw.partial, undefined);
});

test('one failed read leaves the other five intact and names itself in errors', async () => {
  const complete = withoutFetchTime(await getPRRawData('org/app', 20, true));
  const lost: Record<Read, Partial<PRRawSnapshot>> = {
    'pr.checks': { checksStdout: '', checksAvailable: false },
    'pr.view': { prStateStdout: '', prStateError: 'HTTP 502: Bad Gateway', author: undefined },
    'issues.comments': { commentsStdout: '' },
    'pulls.reviewThreads': { reviewCommentsStdout: '' },
    'pulls.commits': { latestCommitStdout: '' },
    'pr.reviews': { reviewMetaStdout: '' },
  };
  for (const [index, read] of READS.entries()) {
    state.failing = read;
    const prNum = 21 + index;
    const raw = withoutFetchTime(await getPRRawData('org/app', prNum, true));
    assert.deepEqual(
      raw,
      { ...complete, ...lost[read], errors: [`${read}#${prNum}: HTTP 502: Bad Gateway`] },
      read,
    );
  }
});

test('a held query budget in any read rejects the refresh and keeps the cached snapshot', async () => {
  for (const [index, read] of READS.entries()) {
    const prNum = 40 + index;
    const confirmed = await getPRRawData('org/app', prNum);
    state.failing = read;
    state.failure = () => new GitHubQueryBudgetError(new Date(Date.now() + 60_000).toISOString());
    await assert.rejects(getPRRawData('org/app', prNum, true), GitHubQueryBudgetError, read);
    state.failing = undefined;
    const before = calls.length;
    assert.deepEqual(await getPRRawData('org/app', prNum), confirmed, read);
    assert.equal(calls.length, before, `${read}: the cached snapshot answers without GitHub`);
  }
});
