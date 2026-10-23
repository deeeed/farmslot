import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { refreshReviewGateView, reviewGateRefreshBlocksPost } from '../src/review-gate-refresh.js';

test('a refused refresh reads the revised gate without starting or retrying a review', async () => {
  const run: Run = {
    id: 'run',
    familyId: 'run',
    parentRunId: null,
    familyRootTicketOrPr: 'TEST',
    flowType: 'review-pr',
    lane: 'production',
    variant: null,
    mode: 'autonomous',
    status: 'human-gating',
    project: 'fixture',
    ticketOrPr: 'TEST',
    slotId: null,
    branch: 'feature',
    taskFile: 'task/TASK.md',
    steps: [],
    decisions: [
      {
        id: 'gate',
        type: 'engine_review_posting',
        title: 'Review',
        description: 'Revised findings need attention',
        actions: [{ id: 'dismiss', label: 'Dismiss', style: 'secondary' }],
        createdAt: '2026-10-21T10:00:00Z',
      },
    ],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-6.1-sol' },
    createdAt: '2026-10-21T10:00:00Z',
    updatedAt: '2026-10-21T10:01:00Z',
  };
  let refreshes = 0,
    reads = 0;
  const result = await refreshReviewGateView(
    async () => {
      refreshes++;
      throw new Error('Revised finding requires COMMENT');
    },
    async () => {
      reads++;
      return { run };
    },
  );
  assert.equal(refreshes, 1);
  assert.equal(reads, 1);
  assert.equal(
    result.run?.decisions[0].actions.some((action) => action.id === 'post'),
    false,
  );
  assert.equal(result.error, 'Revised finding requires COMMENT');
  assert.equal(reviewGateRefreshBlocksPost(false, result.error), true);

  // An infrastructure failure may read back an unchanged gate that still offers Post.
  const oldGate: Run = {
    ...run,
    decisions: run.decisions.map((decision) => ({
      ...decision,
      actions: [{ id: 'post', label: 'Post', style: 'primary' }],
    })),
  };
  const failed = await refreshReviewGateView(
    async () => {
      throw new Error('Gateway unavailable');
    },
    async () => ({ run: oldGate }),
  );
  assert.equal(failed.run?.decisions[0].actions[0].id, 'post');
  assert.equal(reviewGateRefreshBlocksPost(false, failed.error), true);
  assert.equal(reviewGateRefreshBlocksPost(true, null), true);
  const refreshed = await refreshReviewGateView(
    async () => ({ run: oldGate }),
    async () => {
      throw new Error('Successful refresh must not need a fallback read');
    },
  );
  assert.equal(reviewGateRefreshBlocksPost(false, refreshed.error), false);
});
