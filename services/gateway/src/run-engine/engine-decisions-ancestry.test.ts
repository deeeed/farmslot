import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';
import * as store from '../runs/store.js';

const runs = new Map<string, Run>();
let release: () => void = () => {};
let lookupStarted: () => void = () => {};

mock.module('../runs/store.js', {
  namedExports: {
    ...store,
    getRun: (id: string) => runs.get(id),
    getAllRunsWithArchived: async () => {
      lookupStarted();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [...runs.values()];
    },
    listRuns: () => ({ runs: [...runs.values()] }),
    updateRun: (id: string, patch: Partial<Run>) => {
      const run = { ...runs.get(id)!, ...patch };
      runs.set(id, run);
      return run;
    },
  },
});
const { handleRepeatReviewDecision } = await import('./engine-decisions.js');

const prior = makeRun({
  id: 'prior-review',
  familyId: 'family-1',
  flowType: 'review-pr',
  status: 'done',
  project: 'farm-a',
  ticketOrPr: 'owner/repo#42',
  steps: [],
  decisions: [],

  reviewResult: {
    recommendation: 'request changes',
    reviewMd: 'review.md',
    lineComments: [],
    reviewSnapshot: {
      source: 'github-pr',
      capturedAt: '2026-10-05T09:00:00.000Z',
      headSha: '5f85b47bfa4f7d8ec1888605f0cd2f025fffb804',
    },
  },
  createdAt: '2026-10-05T09:00:00.000Z',
  completedAt: '2026-10-05T10:00:00.000Z',
});

for (const includePrior of [true, false]) {
  for (const [label, interrupt] of [
    ['cancel', { status: 'cancelled' }],
    ['pause', { status: 'paused' }],
    ['replay', { engineState: { generation: 2 } }],
  ] as const) {
    test(`a ${label} during the history lookup preserves ownership, prior=${includePrior}`, async () => {
      const current: Run = {
        ...prior,
        id: 'current',
        status: 'writing-task',
        createdAt: '2026-10-05T11:00:00.000Z',
        decisions: [],
        reviewResult: undefined,
        completedAt: undefined,
        engineState: { generation: 1 },
      };
      runs.clear();
      if (includePrior) runs.set(prior.id, prior);
      runs.set(current.id, current);
      const started = new Promise<void>((resolve) => (lookupStarted = resolve));
      const handled = handleRepeatReviewDecision(current.id, current, {
        repository: 'owner/repo',
        prNumber: 42,
        headSha: 'da6b612ef57bc81a6c14bc873810b66ee0720eb0',
      });
      await started;
      runs.set(current.id, { ...runs.get(current.id)!, ...interrupt });
      release();
      await assert.rejects(handled, /changed during the review history lookup/);
      const after = runs.get(current.id)!;
      assert.deepEqual(after.decisions, []);
      assert.equal(after.status, 'status' in interrupt ? interrupt.status : 'writing-task');
    });
  }
}
