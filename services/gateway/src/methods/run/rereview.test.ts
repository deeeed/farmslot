import assert from 'node:assert/strict';
import test, { beforeEach, mock } from 'node:test';

import type { Run, RunCreateParams } from '@farmslot/protocol';

import * as github from '../../external/github.js';

const priorHead = '5f85b47bfa4f7d8ec1888605f0cd2f025fffb804';
const liveHead = 'da6b612ef57bc81a6c14bc873810b66ee0720eb0';
const runs = new Map<string, Run>();
let releaseAncestry: () => void = () => {};
let ancestryCalls = 0;
let ancestor = true;

const prior = {
  id: 'prior-review',
  familyId: 'family-1',
  familyRootTicketOrPr: 'owner/repo#42',
  lane: 'production',
  flowType: 'review-pr',
  status: 'blocked',
  project: 'farm-a',
  ticketOrPr: 'owner/repo#42',
  slotId: 'slot-1',
  steps: [],
  decisions: [],
  metrics: { runner: 'codex', model: 'gpt-6-astra' },
  effort: 'high',
  agentContexts: [
    {
      id: 'review-context',
      reviewId: 'review-lineage',
      role: 'review',
      label: 'Review',
      runId: 'prior-review',
      slotId: 'slot-1',
      runner: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      status: 'complete',
      reviewResultValidatedAt: 'validated',
      runnerSessionCapturedAt: 'captured',
      runnerSessionId: 'prior-session',
      runnerSessionPath: '/tmp/reviewer.jsonl',
      target: { session: 'slot-1', window: 'review-window', target: 'slot-1:review-window' },
    },
  ],
  reviewResult: {
    kind: 'review',
    prNumber: 42,
    repo: 'owner/repo',
    recommendation: 'request changes',
    reviewMd: 'review.md',
    session: {
      mode: 'cold',
      continuity: 'fresh',
      reviewId: 'review-lineage',
      sessionId: 'prior-session',
      repository: 'owner/repo',
      prNumber: 42,
      lastReviewedHeadSha: priorHead,
    },
    lineComments: [{ path: 'src/a.ts', line: 7, body: 'Fix this.', severity: 'blocking' }],
    reviewSnapshot: {
      source: 'github-pr',
      capturedAt: '2026-10-05T09:00:00.000Z',
      headSha: priorHead,
    },
  },
  createdAt: '2026-10-05T09:00:00.000Z',
} as unknown as Run;
runs.set(prior.id, prior);

mock.module('../../external/github.js', {
  namedExports: {
    ...github,
    fetchGitHubPR: async () => ({ headSha: liveHead, baseSha: 'b'.repeat(40), number: 42 }),
    // Hold every ancestry lookup until both clicks are waiting on GitHub.
    isGitHubAncestor: async () => {
      ancestryCalls += 1;
      await new Promise<void>((resolve) => {
        const previous = releaseAncestry;
        releaseAncestry = () => {
          previous();
          resolve();
        };
      });
      return ancestor;
    },
  },
});
// Load the rest only after the GitHub mock, so engine-decisions binds the mocked lookup.
const fleet = await import('../../fleet/state.js');
const store = await import('../../runs/store.js');
mock.module('../../fleet/state.js', {
  namedExports: {
    ...fleet,
    loadProjectConfig: async () => ({ ci: { repo: 'owner/repo' } }),
    loadFleetStatus: async () => ({
      slots: [
        {
          slot: 'slot-1',
          agent: 'working',
          agentContexts: [{ runId: prior.id, role: 'review' }],
        },
      ],
    }),
  },
});
mock.module('../../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) => runs.get(id),
    getAllRuns: () => [...runs.values()],
    listRuns: () => ({ runs: [...runs.values()] }),
    createRun: (params: RunCreateParams) => {
      assertPrimaryReviewContext(params);
      const run = { ...params, id: `child-${runs.size}`, status: 'created' } as unknown as Run;
      runs.set(run.id, run);
      return run;
    },
    updateRun: (id: string, patch: Partial<Run>) => {
      const run = { ...runs.get(id)!, ...patch };
      runs.set(id, run);
      return run;
    },
  },
});
const orchestrator = await import('../../run-engine/orchestrator.js');
mock.module('../../run-engine/orchestrator.js', {
  namedExports: {
    ...orchestrator,
    applyChainedRunEngineFlags: () => {},
    startRun: async () => {},
  },
});

const { runRereviewLatestHead } = await import('./rereview.js');
const { assertPrimaryReviewContext } = await import('../../run-engine/review-plan.js');
const { resetWarmReviewerSessionsForTest } = await import('../../review/session-mode.js');

beforeEach(() => {
  runs.clear();
  runs.set(prior.id, { ...prior });
  ancestryCalls = 0;
  ancestor = true;
  releaseAncestry = () => {};
  resetWarmReviewerSessionsForTest();
});

test('a retried click during ancestry lookup reuses the WARM child with its primary lineage', async () => {
  const first = runRereviewLatestHead({ runId: prior.id });
  const second = runRereviewLatestHead({ runId: prior.id });
  while (ancestryCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  releaseAncestry();
  const [a, b] = await Promise.all([first, second]);

  const children = [...runs.values()].filter((run) => run.parentRunId === prior.id);
  assert.equal(children.length, 1, 'one warm re-review per head');
  assert.equal(a.runId, children[0]!.id);
  assert.equal(b.runId, children[0]!.id);
  assert.equal(children[0]!.reviewMode, 'warm');
  assert.deepEqual(children[0]!.reviewContext, {
    reviewLineages: [{ repository: 'owner/repo', prNumber: 42, reviewId: 'review-lineage' }],
  });
  assert.deepEqual(children[0]!.repeatReviewContext?.unresolvedFindings, [
    { file: 'src/a.ts', line: 7, description: 'Fix this.' },
  ]);
});

test('a standalone posting decision supplies retained provenance without a publication registry', async () => {
  runs.set(prior.id, {
    ...prior,
    reviewResult: undefined,
    decisions: [
      {
        id: 'posting',
        type: 'engine_review_posting',
        title: 'Review',
        description: 'Head moved',
        actions: [],
        createdAt: prior.createdAt,
        payload: { ...prior.reviewResult!, kind: 'review', repo: 'owner/repo', prNumber: 42 },
      },
    ],
  });
  const click = runRereviewLatestHead({ runId: prior.id });
  while (ancestryCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  releaseAncestry();
  const result = await click;
  assert.equal(result.mode, 'warm-handoff');
  assert.equal(
    runs.get(result.runId!)?.reviewContext?.reviewLineages[0]?.reviewId,
    'review-lineage',
  );
});

test('ambiguous standalone session evidence refuses before replacing the parent', async () => {
  runs.set(prior.id, {
    ...prior,
    agentContexts: [
      ...prior.agentContexts!,
      { ...prior.agentContexts![0], id: 'other-context', runnerSessionId: 'other-session' },
    ],
    decisions: [
      {
        id: 'other-posting',
        type: 'engine_review_posting',
        title: 'Review',
        description: 'Head moved',
        actions: [],
        createdAt: prior.createdAt,
        payload: {
          ...prior.reviewResult!,
          kind: 'review',
          repo: 'owner/repo',
          prNumber: 42,
          session: { ...prior.reviewResult!.session!, sessionId: 'other-session' },
        },
      },
    ],
  });
  const click = runRereviewLatestHead({ runId: prior.id });
  const refused = assert.rejects(click, /ambiguous session provenance/);
  while (ancestryCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  releaseAncestry();
  await refused;
  assert.equal(runs.size, 1);
  assert.equal(runs.get(prior.id)!.status, 'blocked');
});

test('missing or ambiguous lineage preserves the parent without creating a child', async () => {
  const result = prior.reviewResult!;
  for (const state of [
    { reviewResult: { ...result, session: undefined } },
    { repeatReviewContext: { session: { ...result.session!, reviewId: 'review-other' } } },
  ]) {
    runs.set(prior.id, { ...prior, ...state } as Run);
    await assert.rejects(runRereviewLatestHead({ runId: prior.id }), /missing or ambiguous/);
    assert.equal(runs.size, 1);
    assert.equal(runs.get(prior.id)!.status, 'blocked');
  }
});

test('unavailable retained session refuses before superseding the parent', async () => {
  resetWarmReviewerSessionsForTest();
  runs.set(prior.id, { ...prior, agentContexts: [] });
  const click = runRereviewLatestHead({ runId: prior.id });
  const refused = assert.rejects(click, /no verified retained session/);
  while (ancestryCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  releaseAncestry();
  await refused;
  assert.equal(runs.size, 1);
  assert.equal(runs.get(prior.id)!.status, 'blocked');
});

test('a rebased head refuses WARM without changing the parent', async () => {
  ancestor = false;
  const click = runRereviewLatestHead({ runId: prior.id });
  const refused = assert.rejects(click, /WARM review unavailable.*not an ancestor/);
  while (ancestryCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  releaseAncestry();
  await refused;
  assert.equal(runs.size, 1);
  assert.equal(runs.get(prior.id)!.status, 'blocked');
});

test('a parent cancelled during the ancestry lookup gets no warm re-review', async () => {
  for (const id of [...runs.keys()]) if (id !== prior.id) runs.delete(id);
  runs.set(prior.id, { ...prior, status: 'blocked' } as Run);
  ancestryCalls = 0;
  const click = runRereviewLatestHead({ runId: prior.id });
  while (ancestryCalls < 1) await new Promise((resolve) => setImmediate(resolve));
  runs.set(prior.id, { ...runs.get(prior.id)!, status: 'cancelled' } as Run);
  releaseAncestry();
  await assert.rejects(click, /is cancelled/);
  assert.equal(
    [...runs.values()].filter((run) => run.parentRunId === prior.id).length,
    0,
    'a cancelled review starts no child',
  );
  assert.equal(runs.get(prior.id)!.status, 'cancelled');
});
