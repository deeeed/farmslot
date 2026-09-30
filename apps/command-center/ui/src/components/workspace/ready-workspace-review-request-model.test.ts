import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addReadyReviewLoop,
  createReadyReviewLoop,
  readyReviewLoopRequestPayload,
  readyReviewRequestProgress,
  readyRunnerLabel,
  removeReadyReviewLoop,
  setReadyReviewLoopModelEffort,
  setReadyReviewLoopRunner,
  setReadyReviewLoopSessionIntent,
} from './ready-workspace-review-request-model.js';

test('ready workspace review request model labels and creates loops', () => {
  assert.equal(readyRunnerLabel('', 'claude'), 'claude');
  assert.equal(readyRunnerLabel('same', 'same'), 'Current runner');
  assert.equal(readyRunnerLabel('codex', 'claude'), 'Codex');
  assert.deepEqual(createReadyReviewLoop(2, 'claude'), {
    id: 2,
    runner: 'claude',
    sessionIntent: 'resume',
    model: 'opus',
    effort: '',
  });
  assert.deepEqual(createReadyReviewLoop(3, 'pi'), {
    id: 3,
    runner: 'pi',
    sessionIntent: 'resume',
    model: 'grok-4.6',
    effort: 'medium',
  });
});

test('ready workspace review request model mutates loops with max and minimum guards', () => {
  let state = addReadyReviewLoop({
    loops: [{ id: 1, runner: 'claude', sessionIntent: 'reset' }],
    nextId: 2,
    currentRunner: 'claude',
  });
  assert.deepEqual(state, {
    loops: [
      { id: 1, runner: 'claude', sessionIntent: 'reset' },
      { id: 2, runner: 'claude', sessionIntent: 'resume', model: 'opus', effort: '' },
    ],
    nextId: 3,
  });
  assert.deepEqual(removeReadyReviewLoop(state.loops, 1), [
    { id: 2, runner: 'claude', sessionIntent: 'resume', model: 'opus', effort: '' },
  ]);
  assert.deepEqual(
    removeReadyReviewLoop([{ id: 1, runner: 'claude', sessionIntent: 'resume' }], 1),
    [{ id: 1, runner: 'claude', sessionIntent: 'resume' }],
  );
  assert.deepEqual(setReadyReviewLoopRunner(state.loops, 2, 'codex'), [
    { id: 1, runner: 'claude', sessionIntent: 'reset' },
    { id: 2, runner: 'codex', sessionIntent: 'resume', model: 'gpt-6.1-sol', effort: 'high' },
  ]);
  const customized = setReadyReviewLoopModelEffort(state.loops, 2, 'sonnet', 'low');
  assert.deepEqual(setReadyReviewLoopRunner(customized, 2, 'claude'), customized);
  assert.deepEqual(setReadyReviewLoopSessionIntent(state.loops, 2, 'resume'), [
    { id: 1, runner: 'claude', sessionIntent: 'reset' },
    { id: 2, runner: 'claude', sessionIntent: 'resume', model: 'opus', effort: '' },
  ]);
  assert.deepEqual(setReadyReviewLoopModelEffort(state.loops, 2, 'sonnet', 'low'), [
    { id: 1, runner: 'claude', sessionIntent: 'reset' },
    { id: 2, runner: 'claude', sessionIntent: 'resume', model: 'sonnet', effort: 'low' },
  ]);

  state = addReadyReviewLoop({
    loops: Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      runner: 'claude',
      sessionIntent: 'resume' as const,
    })),
    nextId: 6,
    currentRunner: 'claude',
  });
  assert.equal(state.loops.length, 5);
  assert.equal(state.nextId, 6);
});

test('ready workspace review request model builds ordered request payload', () => {
  const payload = readyReviewLoopRequestPayload(
    [
      { id: 1, runner: 'claude', sessionIntent: 'resume' },
      {
        id: 2,
        runner: 'codex',
        sessionIntent: 'reset',
        model: 'gpt-6-astra',
        effort: 'low',
      },
    ],
    'claude',
  );

  assert.equal(payload.requireCrossRunner, true);
  assert.deepEqual(
    payload.loops.map((loop) => [
      loop.order,
      loop.runner,
      loop.model,
      loop.effort,
      loop.validationDepth,
      loop.sessionIntent,
    ]),
    [
      [1, 'claude', undefined, undefined, 'static-code', 'resume'],
      [2, 'codex', 'gpt-6-astra', 'low', 'static-code', 'reset'],
    ],
  );

  const piPayload = readyReviewLoopRequestPayload([createReadyReviewLoop(1, 'pi')], 'claude');
  assert.equal(piPayload.requireCrossRunner, true);
  assert.deepEqual(
    piPayload.loops.map((loop) => [loop.runner, loop.model, loop.effort]),
    [['pi', 'grok-4.6', 'medium']],
  );
});

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
        resolvedAction: 'request-extra-review',
      },
    ],
    agentContexts: [
      {
        id: 'rev-claude',
        role: 'self-review',
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
    publishGate: { pendingReviewPlan: [{ order: 1, runner: 'claude', sessionIntent: 'resume' }] },
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
  run.engineState.publishGate!.pendingReviewPlan = [];
  run.decisions[0]!.context = { reviewRequestConsumedAt: requestedAt };
  assert.equal(readyReviewRequestProgress(run), '');
  run.status = 'cancelled';
  assert.equal(readyReviewRequestProgress(run), '');
});

test('Fresh remains an explicit review request choice', () => {
  const loop = createReadyReviewLoop(1, 'claude');
  assert.equal(loop.sessionIntent, 'resume');
  const fresh = setReadyReviewLoopSessionIntent([loop], 1, 'reset');
  assert.equal(readyReviewLoopRequestPayload(fresh, 'claude').loops[0]?.sessionIntent, 'reset');
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
        resolvedAction: 'request-extra-review',
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
