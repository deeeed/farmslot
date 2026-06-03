import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addReadyReviewLoop,
  createReadyReviewLoop,
  readyReviewLoopRequestPayload,
  readyRunnerLabel,
  removeReadyReviewLoop,
  setReadyReviewLoopDepth,
  setReadyReviewLoopRunner,
} from './ready-workspace-review-request-model.js';

test('ready workspace review request model labels and creates loops', () => {
  assert.equal(readyRunnerLabel('', 'claude'), 'claude');
  assert.equal(readyRunnerLabel('same', 'same'), 'Current runner');
  assert.equal(readyRunnerLabel('codex', 'claude'), 'Codex');
  assert.deepEqual(createReadyReviewLoop(2, 'claude'), { id: 2, runner: 'claude' });
});

test('ready workspace review request model mutates loops with max and minimum guards', () => {
  let state = addReadyReviewLoop({
    loops: [{ id: 1, runner: 'claude' }],
    nextId: 2,
    currentRunner: 'claude',
  });
  assert.deepEqual(state, {
    loops: [
      { id: 1, runner: 'claude' },
      { id: 2, runner: 'claude' },
    ],
    nextId: 3,
  });
  assert.deepEqual(removeReadyReviewLoop(state.loops, 1), [{ id: 2, runner: 'claude' }]);
  assert.deepEqual(removeReadyReviewLoop([{ id: 1, runner: 'claude' }], 1), [
    { id: 1, runner: 'claude' },
  ]);
  assert.deepEqual(setReadyReviewLoopRunner(state.loops, 2, 'codex'), [
    { id: 1, runner: 'claude' },
    { id: 2, runner: 'codex' },
  ]);
  assert.deepEqual(setReadyReviewLoopDepth(state.loops, 1, 'full-live'), [
    { id: 1, runner: 'claude', validationDepth: 'full-live' },
    { id: 2, runner: 'claude' },
  ]);

  state = addReadyReviewLoop({
    loops: Array.from({ length: 5 }, (_, index) => ({ id: index + 1, runner: 'claude' })),
    nextId: 6,
    currentRunner: 'claude',
  });
  assert.equal(state.loops.length, 5);
  assert.equal(state.nextId, 6);
});

test('ready workspace review request model builds ordered request payload', () => {
  const payload = readyReviewLoopRequestPayload(
    [
      { id: 1, runner: 'claude' },
      { id: 2, runner: 'codex', validationDepth: 'full-live' },
    ],
    'claude',
  );

  assert.equal(payload.requireCrossRunner, true);
  assert.deepEqual(
    payload.loops.map((loop) => [loop.order, loop.runner, loop.validationDepth]),
    [
      [1, 'claude', 'static-code'],
      [2, 'codex', 'full-live'],
    ],
  );
});
