import assert from 'node:assert/strict';
import test from 'node:test';

import { readyReviewRequestProgress } from './ready-workspace-review-request-model.js';

test('review request progress spans acceptance, startup, execution, and remaining review preparation', () => {
  const requestedAt = '2026-09-30T03:20:00.000Z';
  const run: NonNullable<Parameters<typeof readyReviewRequestProgress>[0]> = {
    status: 'human-gating',
    decisions: [
      {
        id: 'gate',
        type: 'engine_human_gate',
        title: 'Publication',
        description: '',
        actions: [],
        createdAt: requestedAt,
        resolvedAt: requestedAt,
        resolvedAction: 'request-review',
      },
    ],
    agentContexts: [
      {
        id: 'rev-claude',
        role: 'review',
        label: 'Reviewer',
        runner: 'claude',
        runId: 'run',
        slotId: 'slot',
        status: 'complete',
        attemptStartedAt: '2026-09-29T00:00:00.000Z',
      },
    ],
  };
  assert.equal(readyReviewRequestProgress(run), 'Review requested; waiting for processing.');
  run.engineState = {
    publishGate: {
      reviewSequence: [{ runner: 'claude', model: null, effort: null, mode: 'cold' }],
    },
  };
  assert.equal(readyReviewRequestProgress(run), 'Review requested; preparing the reviewer.');
  const context = run.agentContexts![0]!;
  context.attemptStartedAt = '2026-09-30T03:21:00.000Z';
  context.status = 'launching';
  assert.equal(
    readyReviewRequestProgress(run),
    'Starting claude review; waiting for prompt acceptance.',
  );
  context.status = 'working';
  context.attemptStartedAt = '2026-09-30T03:19:00.000Z';
  assert.equal(readyReviewRequestProgress(run), 'claude review is running.');
  context.attemptStartedAt = '2026-09-30T03:21:00.000Z';
  context.status = 'complete';
  assert.equal(
    readyReviewRequestProgress(run),
    'Review finished; preparing the next review or refreshing the publication package.',
  );
  run.engineState!.publishGate!.reviewSequence = [];
  run.decisions[0]!.context = { reviewRequestConsumedAt: requestedAt };
  assert.equal(readyReviewRequestProgress(run), '');
  run.status = 'cancelled';
  assert.equal(readyReviewRequestProgress(run), '');
});

test('a newer publication gate clears old request progress and rejections', () => {
  const run: NonNullable<Parameters<typeof readyReviewRequestProgress>[0]> = {
    status: 'human-gating',
    decisions: [
      {
        id: 'request',
        type: 'engine_human_gate',
        title: '',
        description: '',
        actions: [],
        createdAt: '2026-09-30T00:00:00Z',
        resolvedAt: '2026-09-30T00:01:00Z',
        resolvedAction: 'request-review',
      },
      {
        id: 'publish',
        type: 'engine_human_gate',
        title: '',
        description: '',
        actions: [],
        createdAt: '2026-09-30T00:02:00Z',
        resolvedAt: '2026-09-30T00:03:00Z',
        resolvedAction: 'approve-publish',
      },
    ],
  };
  assert.equal(readyReviewRequestProgress(run), '');
});
