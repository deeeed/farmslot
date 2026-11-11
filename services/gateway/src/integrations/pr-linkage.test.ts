import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';

import type { RestServiceOpts } from './github-client.js';
import { fakeGitHubService } from './github-test-fixtures.js';

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
let metadataFailure: Error | undefined;
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
const clientModule = await import('./github-client.js');
const fakeGithub = fakeGitHubService(clientModule.github, {
  prView: async (repo, number, _fields, _opts?) => {
    requests.push(['pr', 'view', String(number)]);
    if (metadataFailure) throw metadataFailure;
    return { number: candidate.number, state: candidate.state, headRefOid: candidate.headRefOid };
  },
  prListFields: async (_repo, _fields, params, _opts?) => {
    const args = ['pr', 'list'];
    if (params.state === 'all') args.push('all');
    if (params.head) args.push('--head', params.head);
    requests.push(args);
    const hasAll = params.state === 'all';
    if (hasAll || candidate.state === 'OPEN')
      return [
        { number: candidate.number, state: candidate.state, headRefOid: candidate.headRefOid },
      ];
    return [];
  },
  rest: async (_method: string, path: string, _opts?: RestServiceOpts) => {
    requests.push(['api', path]);
    return { state: 'closed', head: { ref: 'fix/reused' } };
  },
});
mock.module('./github-client.js', {
  namedExports: { ...clientModule, github: fakeGithub },
});
after(() => mock.restoreAll());
const { findPRNumber } = await import('./pr-linkage.js');
const { makeRun, makeReadyGatePackage } = await import('../run-engine/test-fixtures.js');

beforeEach(() => {
  candidate = { number: 193, state: 'CLOSED', headRefOid: unrelatedHead };
  cached = null;
  bound = [];
  requests = [];
  metadataFailure = undefined;
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

test('an inherited dispatch baseline cannot claim an unrelated closed PR', async () => {
  const run = makeRun({
    branch: 'fix/reused',
    prNumber: candidate.number,
    worktreeHeadAtDispatch: candidate.headRefOid,
    engineState: {
      publishGate: {
        reviews: [
          {
            id: 'review',
            mode: 'cold',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewedHeadSha: head,
          },
        ],
      },
    },
  });
  assert.equal(await findPRNumber(run, 'owner/repo', { noRetry: true }), null);
});

test('saved PR metadata failure refuses before any discovery or duplicate creation', async () => {
  metadataFailure = new Error('GitHub query budget exhausted');
  const run = makeRun({ branch: 'fix/reused', prNumber: candidate.number });
  await assert.rejects(findPRNumber(run, 'owner/repo', { noRetry: true }), metadataFailure);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].slice(0, 2), ['pr', 'view']);
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
      pr: { host: 'GITHUB.COM', repo: 'Owner/Repo', number: candidate.number },
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

test('a closed PR at the approved publication head stays linked without a review or publication receipt', async () => {
  const run = makeRun({
    branch: 'fix/reused',
    prNumber: candidate.number,
    decisions: [
      {
        id: 'publication',
        type: 'engine_human_gate',
        title: 'Publish',
        description: '',
        actions: [],
        createdAt: '2026-10-26T00:00:00Z',
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: 'owner/repo',
          branch: 'fix/reused',
          workerReport: '',
          diffStat: { files: 1, additions: 1, deletions: 1 },
          prPackage: makeReadyGatePackage({ headSha: candidate.headRefOid }),
        },
      },
    ],
  });
  assert.equal(await findPRNumber(run, 'owner/repo', { noRetry: true }), candidate.number);
});
