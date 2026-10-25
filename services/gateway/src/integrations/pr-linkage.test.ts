import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

process.env.NODE_TEST_CONTEXT = '1';
await import('../runtime/mock-pty.test-support.js');

interface Candidate {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefOid: string;
}

const head = 'a'.repeat(40);
const unrelatedHead = 'b'.repeat(40);
let candidate: Candidate;
let cached: number | null;
let bound: number[];
let requests: string[][];
mock.module('./github-bindings-cache.js', {
  namedExports: {
    getBinding: () => cached,
    invalidateBinding: () => {
      cached = null;
    },
    setBinding: (_branch: string, _repo: string, number: number) => {
      bound.push(number);
    },
  },
});
mock.module('./github-client.js', {
  namedExports: {
    ghRequest: async (args: string[]) => {
      requests.push(args);
      if (args[0] === 'pr' && args[1] === 'view')
        return { stdout: JSON.stringify(candidate), stderr: '' };
      if (args[0] === 'api')
        return { stdout: JSON.stringify({ state: 'closed', head: 'fix/reused' }), stderr: '' };
      assert.deepEqual(args.slice(0, 2), ['pr', 'list']);
      const prs = args.includes('all') || candidate.state === 'OPEN' ? [candidate] : [];
      return { stdout: JSON.stringify(prs), stderr: '' };
    },
  },
});
after(() => mock.restoreAll());
const { findPRNumber } = await import('./pr-linkage.js');
const { makeRun } = await import('../run-engine/test-fixtures.js');

beforeEach(() => {
  candidate = { number: 193, state: 'CLOSED', headRefOid: unrelatedHead };
  cached = null;
  bound = [];
  requests = [];
});

test('branch fallback ignores an unrelated closed PR after the open lookup misses', async () => {
  const run = makeRun({ branch: 'fix/reused', prNumber: undefined });
  assert.equal(await findPRNumber(run, 'owner/repo', { noRetry: true }), null);
  assert.deepEqual(bound, []);
  assert.ok(requests.some((args) => args.includes('all')));
});

test('a stale disk binding cannot reintroduce the unrelated closed PR', async () => {
  cached = candidate.number;
  const run = makeRun({ branch: 'fix/reused', prNumber: undefined });
  assert.equal(await findPRNumber(run, 'owner/repo', { noRetry: true }), null);
  assert.equal(cached, null);
  assert.deepEqual(bound, []);
});

test('a previously persisted unrelated closed PR is revalidated before publication', async () => {
  const run = makeRun({ branch: 'fix/reused', prNumber: candidate.number });
  assert.equal(await findPRNumber(run, 'owner/repo', { noRetry: true }), null);
  assert.ok(requests.some((args) => args[1] === 'view'));
});

for (const state of ['OPEN', 'MERGED'] as const) {
  test(`${state} discovery and persisted bindings retain their behavior`, async () => {
    candidate.state = state;
    for (const prNumber of [undefined, candidate.number]) {
      const run = makeRun({ branch: 'fix/reused', prNumber });
      assert.equal(await findPRNumber(run, 'owner/repo', { noRetry: true }), candidate.number);
    }
  });
}

test('closed PRs published by this run remain linked regardless of head changes', async () => {
  const run = makeRun({ branch: 'fix/reused', prNumber: candidate.number });
  run.prPublications = [
    {
      pr: { host: 'github.com', repo: 'Owner/Repo', number: candidate.number },
      publishedAt: run.createdAt,
    },
  ];
  assert.equal(await findPRNumber(run, 'owner/repo', { noRetry: true }), candidate.number);
});

test('closed PRs whose head was reviewed by this run remain linked', async () => {
  const run = makeRun({
    branch: 'fix/reused',
    prNumber: undefined,
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'review',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewSnapshot: {
              headSha: head,
              source: 'local-git',
              capturedAt: '2026-10-26T00:00:00Z',
            },
          },
        ],
      },
    },
  });
  candidate.headRefOid = head;
  assert.equal(await findPRNumber(run, 'owner/repo', { noRetry: true }), candidate.number);
});

test('a closed PR from an earlier review attempt remains part of this run', async () => {
  const run = makeRun({
    branch: 'fix/reused',
    prNumber: candidate.number,
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'review',
            mode: 'warm',
            loopNumber: 2,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewedHeadSha: head,
            attempts: [
              {
                mode: 'cold',
                loopNumber: 1,
                verdict: 'issues',
                unresolvedCount: 1,
                reviewSnapshot: {
                  headSha: unrelatedHead,
                  source: 'local-git',
                  capturedAt: '2026-10-25T00:00:00Z',
                },
              },
            ],
          },
        ],
      },
    },
  });
  assert.equal(await findPRNumber(run, 'owner/repo', { noRetry: true }), candidate.number);
});
