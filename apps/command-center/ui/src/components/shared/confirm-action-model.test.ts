import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfirmActionTimer } from './confirm-action-model.js';

function context() {
  let pending: string | null = null;
  const timer = new ConfirmActionTimer({
    pendingConfirm: () => pending,
    setPendingConfirm: (next) => {
      pending = next;
    },
  });
  return {
    pending: () => pending,
    timer,
  };
}

test('ConfirmActionTimer arms first click and executes matching confirmation', () => {
  const state = context();
  let executed = 0;
  try {
    state.timer.confirm('dismiss', () => {
      executed += 1;
    });
    assert.equal(state.pending(), 'dismiss');
    assert.equal(executed, 0);

    state.timer.confirm('dismiss', () => {
      executed += 1;
    });
    assert.equal(state.pending(), null);
    assert.equal(executed, 1);
  } finally {
    state.timer.clear();
  }
});

test('ConfirmActionTimer replaces pending action and clears after timeout', async () => {
  const state = context();
  try {
    state.timer.confirm('post', () => {}, 50);
    assert.equal(state.pending(), 'post');

    state.timer.confirm('dismiss', () => {}, 5);
    assert.equal(state.pending(), 'dismiss');

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(state.pending(), null);
  } finally {
    state.timer.clear();
  }
});
