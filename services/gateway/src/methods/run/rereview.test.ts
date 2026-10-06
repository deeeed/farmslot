import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { Run, RunCreateParams } from '@farmslot/protocol';

import * as github from '../../external/github.js';

const priorHead = '5f85b47bfa4f7d8ec1888605f0cd2f025fffb804';
const liveHead = 'da6b612ef57bc81a6c14bc873810b66ee0720eb0';
const runs = new Map<string, Run>();
let releaseAncestry: () => void = () => {};
let ancestryCalls = 0;

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
  metrics: { runner: 'codex', model: 'model' },
  reviewResult: {
    kind: 'review',
    prNumber: 42,
    repo: 'owner/repo',
    recommendation: 'request changes',
    reviewMd: 'review.md',
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
      return false;
    },
  },
});
// Load the rest only after the GitHub mock, so engine-decisions binds the mocked lookup.
const fleet = await import('../../fleet/state.js');
const store = await import('../../runs/store.js');
const orchestrator = await import('../../run-engine/orchestrator.js');
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
mock.module('../../run-engine/orchestrator.js', {
  namedExports: {
    ...orchestrator,
    applyChainedRunEngineFlags: () => {},
    startRun: async () => {},
  },
});

const { runRereviewLatestHead } = await import('./rereview.js');

test('a retried click during the ancestry lookup reuses the first rebased re-review', async () => {
  const first = runRereviewLatestHead({ runId: prior.id });
  const second = runRereviewLatestHead({ runId: prior.id });
  while (ancestryCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  releaseAncestry();
  const [a, b] = await Promise.all([first, second]);

  const children = [...runs.values()].filter((run) => run.parentRunId === prior.id);
  assert.equal(children.length, 1, 'one warm re-review per head');
  assert.equal(a.runId, children[0]!.id);
  assert.equal(b.runId, children[0]!.id);
  assert.equal(children[0]!.reviewScope, 'full', 'a rebased head gets a full review');
  assert.deepEqual(children[0]!.repeatReviewContext?.unresolvedFindings, [
    { file: 'src/a.ts', line: 7, description: 'Fix this.' },
  ]);
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
