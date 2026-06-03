import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectCICheckGroup } from '@farmslot/protocol';

import { matchCheckGroups } from '../pr.js';

import {
  buildBatchQuery,
  buildPRChecksArgs,
  chunkPRsByRepo,
  isPRBatchTruncated,
  parseJsonLines,
  prefetchPRBatchViaGraphQL,
  synthesizeRawSnapshotFromGraphQL,
} from './raw-cache.js';

test('buildPRChecksArgs uses JSON buckets so pending checks remain data, not command failure', () => {
  assert.deepEqual(buildPRChecksArgs(41949, 'example-org/example-browser'), [
    'pr',
    'checks',
    '41949',
    '--repo',
    'example-org/example-browser',
    '--json',
    'name,bucket,startedAt,completedAt',
    '--jq',
    '.[] | [.name, .bucket, (.startedAt // ""), (.completedAt // "")] | @tsv',
  ]);
});

// ─── ADR-028 GraphQL batch tests ───

test('chunkPRsByRepo splits a >25-PR repo and leaves smaller repos alone', () => {
  const big = Array.from({ length: 30 }, (_, i) => 100 + i);
  const small = [42, 43];
  const chunks = chunkPRsByRepo(
    new Map([
      ['example-org/example-browser', big],
      ['example-org/example-mobile', small],
    ]),
  );
  const ext = chunks.filter((c) => c.repo === 'example-org/example-browser');
  const mob = chunks.filter((c) => c.repo === 'example-org/example-mobile');
  assert.equal(ext.length, 2, 'big repo splits into 2 chunks');
  assert.equal(ext[0].prs.length, 25);
  assert.equal(ext[1].prs.length, 5);
  assert.deepEqual(ext[0].prs, big.slice(0, 25));
  assert.deepEqual(ext[1].prs, big.slice(25));
  assert.equal(mob.length, 1);
  assert.deepEqual(mob[0].prs, small);
  assert.equal(ext[0].owner, 'example-org');
  assert.equal(ext[0].name, 'example-browser');
});

test('chunkPRsByRepo skips entries whose repo slug is malformed or empty', () => {
  const chunks = chunkPRsByRepo(
    new Map([
      ['no-slash', [1, 2]],
      ['', [3]],
      ['owner/name', []],
      ['o/n', [9]],
    ]),
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].repo, 'o/n');
});

test('buildBatchQuery declares one Int! variable + one alias per PR', () => {
  const q = buildBatchQuery(3);
  assert.match(q, /\$pr_0: Int!/);
  assert.match(q, /\$pr_1: Int!/);
  assert.match(q, /\$pr_2: Int!/);
  assert.match(q, /pr_0: pullRequest\(number: \$pr_0\)/);
  assert.match(q, /pr_2: pullRequest\(number: \$pr_2\)/);
  assert.doesNotMatch(q, /pr_3:/);
  assert.match(q, /statusCheckRollup/);
  assert.match(q, /reviewThreads/);
  assert.match(q, /committedDate/);
});

// Synthesizing the five `*Stdout` strings is the core parity surface — without
// a feature flag, drift here would silently regress the dashboard. Round-trip
// through the existing parsers and assert the structured output matches.
test('synthesizeRawSnapshotFromGraphQL → parseChecksOutput maps CheckRun + StatusContext to expected buckets', () => {
  const snap = synthesizeRawSnapshotFromGraphQL({
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    headRefName: 'feat/x',
    title: 'My PR',
    statusCheckRollup: {
      contexts: {
        nodes: [
          {
            __typename: 'CheckRun',
            name: 'lint',
            conclusion: 'SUCCESS',
            status: 'COMPLETED',
            startedAt: 't1',
            completedAt: 't2',
          },
          {
            __typename: 'CheckRun',
            name: 'unit',
            conclusion: 'FAILURE',
            status: 'COMPLETED',
            startedAt: 't3',
            completedAt: 't4',
          },
          {
            __typename: 'CheckRun',
            name: 'e2e',
            conclusion: null,
            status: 'IN_PROGRESS',
            startedAt: 't5',
            completedAt: '',
          },
          {
            __typename: 'CheckRun',
            name: 'flake',
            conclusion: 'CANCELLED',
            status: 'COMPLETED',
            startedAt: 't6',
            completedAt: 't7',
          },
          {
            __typename: 'StatusContext',
            context: 'continuous-integration/legacy',
            state: 'SUCCESS',
            createdAt: 't8',
          },
        ],
      },
    },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { committedDate: '2026-04-30T12:00:00Z' } }] },
  });

  // Expect TSV rows in the bucket vocabulary that `gh pr checks --json bucket` emits.
  // Don't `.trim()` — that would strip the trailing tab on the last StatusContext
  // row (jq @tsv emits 4 columns with empty trailing fields preserved).
  const lines = snap.checksStdout.replace(/\n$/, '').split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'lint\tpass\tt1\tt2');
  assert.equal(lines[1], 'unit\tfail\tt3\tt4');
  assert.equal(lines[2], 'e2e\tpending\tt5\t');
  assert.equal(lines[3], 'flake\tcancel\tt6\tt7');
  assert.equal(lines[4], 'continuous-integration/legacy\tpass\tt8\t');
  assert.equal(snap.latestCommitStdout.replace(/\n$/, ''), '2026-04-30T12:00:00Z');
});

test('synthesizeRawSnapshotFromGraphQL emits a single TSV line for prState with title last', () => {
  const snap = synthesizeRawSnapshotFromGraphQL({
    state: 'OPEN',
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    reviewDecision: '',
    headRefName: 'feat/y',
    title: 'PR with\ttab in title',
    statusCheckRollup: { contexts: { nodes: [] } },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [] },
  });
  const parts = snap.prStateStdout.replace(/\n$/, '').split('\t');
  assert.equal(parts[0], 'OPEN');
  assert.equal(parts[1], 'CONFLICTING');
  assert.equal(parts[2], 'DIRTY');
  assert.equal(parts[3], '');
  assert.equal(parts[4], 'feat/y');
  assert.equal(parts[5], '');
  assert.equal(parts[6], '');
  assert.equal(parts[7], '');
  assert.equal(parts[8], '');
  // Title may contain tabs; consumers slice(9).join('\t') to recover it.
  assert.equal(parts.slice(9).join('\t'), 'PR with\ttab in title');
});

test('synthesizeRawSnapshotFromGraphQL → parseJsonLines truncates body and tags Bot authors with [bot] suffix', () => {
  const longBody = 'x'.repeat(500);
  const snap = synthesizeRawSnapshotFromGraphQL({
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    headRefName: 'feat/z',
    title: 'T',
    statusCheckRollup: { contexts: { nodes: [] } },
    comments: {
      nodes: [
        {
          databaseId: 1,
          author: { login: 'alice', __typename: 'User' },
          body: 'hi',
          createdAt: 'c1',
          url: 'u1',
        },
        {
          databaseId: 2,
          author: { login: 'cursor', __typename: 'Bot' },
          body: longBody,
          createdAt: 'c2',
          url: 'u2',
        },
      ],
    },
    reviewThreads: {
      nodes: [
        {
          isResolved: true,
          isOutdated: false,
          comments: {
            nodes: [
              {
                databaseId: 7,
                author: { login: 'noisy', __typename: 'Bot' },
                body: 'resolved',
                path: 'f',
                line: 1,
                createdAt: 'c0',
                url: 'u0',
                replyTo: null,
              },
            ],
          },
        },
        {
          isResolved: false,
          isOutdated: false,
          comments: {
            nodes: [
              {
                databaseId: 8,
                author: { login: 'cursor', __typename: 'Bot' },
                body: 'live finding',
                path: 'f',
                line: 2,
                createdAt: 'c8',
                url: 'u8',
                replyTo: null,
              },
              {
                databaseId: 9,
                author: { login: 'arthur', __typename: 'User' },
                body: 'reply',
                path: 'f',
                line: 2,
                createdAt: 'c9',
                url: 'u9',
                replyTo: { databaseId: 8 },
              },
            ],
          },
        },
        {
          isResolved: false,
          isOutdated: true,
          comments: {
            nodes: [
              {
                databaseId: 10,
                author: { login: 'old', __typename: 'Bot' },
                body: 'outdated',
                path: 'f',
                line: 3,
                createdAt: 'c10',
                url: 'u10',
                replyTo: null,
              },
            ],
          },
        },
      ],
    },
    commits: { nodes: [{ commit: { committedDate: 'c11' } }] },
  });

  const issueComments = parseJsonLines(snap.commentsStdout);
  assert.equal(issueComments.length, 2);
  assert.equal(issueComments[0].author, 'alice');
  assert.equal(issueComments[0].user_type, 'User');
  assert.equal(issueComments[1].author, 'cursor');
  assert.equal(issueComments[1].user_type, 'Bot');
  assert.equal(issueComments[1].body?.length, 300, 'issue comment body truncated to 300 chars');

  const reviewComments = parseJsonLines(snap.reviewCommentsStdout);
  assert.equal(reviewComments.length, 2, 'resolved + outdated threads dropped');
  assert.deepEqual(
    reviewComments.map((r) => r.id),
    [8, 9],
  );
  assert.equal(
    reviewComments[0].author,
    'cursor[bot]',
    'Bot login gets [bot] suffix to match REST shape',
  );
  assert.equal(reviewComments[1].author, 'arthur', 'User login unchanged');
  assert.equal(
    reviewComments[1].in_reply_to_id,
    8,
    'replyTo.databaseId surfaces as in_reply_to_id',
  );
});

test('synthesizeRawSnapshotFromGraphQL → matchCheckGroups gives the same MatchedCheckGroup as the REST path would', () => {
  const snap = synthesizeRawSnapshotFromGraphQL({
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    headRefName: 'feat/z',
    title: 'T',
    statusCheckRollup: {
      contexts: {
        nodes: [
          {
            __typename: 'CheckRun',
            name: 'Test lint',
            conclusion: 'SUCCESS',
            status: 'COMPLETED',
            startedAt: '',
            completedAt: '2026-04-24T09:40:12Z',
          },
          {
            __typename: 'CheckRun',
            name: 'Run tests / Unit tests (1)',
            conclusion: 'SUCCESS',
            status: 'COMPLETED',
            startedAt: '',
            completedAt: '2026-04-24T09:34:24Z',
          },
          {
            __typename: 'CheckRun',
            name: 'Run tests / Unit tests (2)',
            conclusion: 'SUCCESS',
            status: 'COMPLETED',
            startedAt: '',
            completedAt: '2026-04-24T09:34:17Z',
          },
        ],
      },
    },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [] },
  });
  const groups: ProjectCICheckGroup[] = [
    { name: 'Test lint', match: 'Test lint', matchMode: 'exact', aggregate: 'all' },
    {
      name: 'Unit tests',
      match: '^Run tests / Unit tests \\(\\d+\\)$',
      matchMode: 'regex',
      aggregate: 'all',
    },
  ];
  // Reuse the existing TSV parser exactly as fetchPRData does, then feed
  // the result into matchCheckGroups. Mirrors lines 315-316 of pr.ts.
  interface ParsedCheck {
    name: string;
    status: string;
    startedAt: string;
    completedAt: string;
    index: number;
  }
  const checks: ParsedCheck[] = [];
  let idx = 0;
  for (const line of snap.checksStdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, status, startedAt, completedAt] = line.split('\t');
    checks.push({ name, status, startedAt, completedAt, index: idx++ });
  }
  const matched = matchCheckGroups(checks, groups);
  assert.deepEqual(matched, [
    { name: 'Test lint', status: 'pass', watchName: 'Test lint' },
    { name: 'Unit tests', status: 'pass', watchName: 'Unit tests' },
  ]);
});

test('synthesizeRawSnapshotFromGraphQL emits empty stdout strings when GraphQL returned no nodes', () => {
  const snap = synthesizeRawSnapshotFromGraphQL({
    state: 'CLOSED',
    mergeable: 'UNKNOWN',
    mergeStateStatus: 'UNKNOWN',
    reviewDecision: '',
    headRefName: 'foo',
    title: 'closed',
    statusCheckRollup: null,
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [] },
  });
  assert.equal(snap.checksStdout, '');
  assert.equal(snap.commentsStdout, '');
  assert.equal(snap.reviewCommentsStdout, '');
  assert.equal(snap.latestCommitStdout, '');
  assert.equal(snap.prStateStdout, 'CLOSED\tUNKNOWN\tUNKNOWN\t\tfoo\t\t\t\t\tclosed\n');
});

test('synthesizeRawSnapshotFromGraphQL returns an empty snapshot for a null/undefined PR node', () => {
  const fromNull = synthesizeRawSnapshotFromGraphQL(null);
  assert.equal(fromNull.checksStdout, '');
  assert.equal(fromNull.prStateStdout, '');
  assert.equal(fromNull.commentsStdout, '');
  assert.equal(fromNull.reviewCommentsStdout, '');
  assert.equal(fromNull.latestCommitStdout, '');
  assert.ok(
    fromNull.fetchedAt > 0,
    'fetchedAt populated so the cache TTL still ages-out the empty entry',
  );

  const fromUndef = synthesizeRawSnapshotFromGraphQL(undefined);
  assert.equal(fromUndef.prStateStdout, '');
});

test('checkRunBucket maps QUEUED + StatusContext ERROR to the right bucket vocabulary', () => {
  // QUEUED locks the GitHub status enum surface — a checkrun that has been scheduled
  // but hasn't started yet should still surface as 'pending' in the dashboard.
  // StatusContext ERROR (legacy webhook surface) should map to 'fail', not get
  // accidentally bucketed as 'pending'.
  const snap = synthesizeRawSnapshotFromGraphQL({
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    headRefName: 'feat/q',
    title: 'queue test',
    statusCheckRollup: {
      contexts: {
        nodes: [
          {
            __typename: 'CheckRun',
            name: 'queued',
            conclusion: null,
            status: 'QUEUED',
            startedAt: '',
            completedAt: '',
          },
          {
            __typename: 'StatusContext',
            context: 'webhook/legacy',
            state: 'ERROR',
            createdAt: 't0',
          },
        ],
      },
    },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: { nodes: [] },
  });
  const lines = snap.checksStdout.replace(/\n$/, '').split('\n');
  assert.equal(lines[0], 'queued\tpending\t\t');
  assert.equal(lines[1], 'webhook/legacy\tfail\tt0\t');
});

test('prefetchPRBatchViaGraphQL early-returns on empty input without firing GraphQL', async () => {
  // Empty repo map and a map full of malformed slugs should both no-op silently —
  // no log line, no GraphQL call. Asserts the cheap-path guards in place.
  await prefetchPRBatchViaGraphQL(new Map());
  await prefetchPRBatchViaGraphQL(new Map([['no-slash', [1, 2]]]));
  // No assertion target — passing without throwing is the contract. (Coverage
  // for the chunks.length === 0 branch in prefetchPRBatchViaGraphQL.)
});

test('isPRBatchTruncated returns true when GraphQL connections capped at 100', () => {
  // A PR with >100 review threads or >100 status contexts is silently truncated by
  // the batch's `first: 100` slice. The REST/per-PR-paginated path sees them all,
  // so the batch must NOT seed the cache for these PRs — bot findings in late
  // threads or check failures past index 100 would otherwise vanish from
  // matchBotComments / matchCheckGroups until the cache expired.
  assert.equal(isPRBatchTruncated(null), false);
  assert.equal(isPRBatchTruncated(undefined), false);

  // Happy path: both connections fit in their first-100 slice.
  assert.equal(
    isPRBatchTruncated({
      statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [] } },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    }),
    false,
  );

  // Truncated review threads → must skip cache seed.
  assert.equal(
    isPRBatchTruncated({
      statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [] } },
      reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [] },
    }),
    true,
  );

  // Truncated status check rollup → must skip cache seed (PR with 101+ checks).
  assert.equal(
    isPRBatchTruncated({
      statusCheckRollup: { contexts: { pageInfo: { hasNextPage: true }, nodes: [] } },
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    }),
    true,
  );

  // Missing pageInfo (older GraphQL response shape, or absent connections) treated as not-truncated.
  assert.equal(isPRBatchTruncated({}), false);
});

test('buildBatchQuery includes pageInfo on both connection caps so truncation is detectable', () => {
  // Without pageInfo on the connections, `runBatchChunk` cannot tell whether
  // the first-100 slice was complete — and would silently seed truncated data.
  const q = buildBatchQuery(1);
  // statusCheckRollup.contexts MUST request pageInfo.
  const checksMatch = q.match(
    /statusCheckRollup\s*\{\s*contexts\(first:\s*100\)\s*\{[^}]*pageInfo\s*\{\s*hasNextPage\s*\}/,
  );
  assert.ok(checksMatch, 'statusCheckRollup.contexts must request pageInfo.hasNextPage');
  // reviewThreads MUST request pageInfo.
  const threadsMatch = q.match(
    /reviewThreads\(first:\s*100\)\s*\{[^}]*pageInfo\s*\{\s*hasNextPage\s*\}/,
  );
  assert.ok(threadsMatch, 'reviewThreads must request pageInfo.hasNextPage');
});
