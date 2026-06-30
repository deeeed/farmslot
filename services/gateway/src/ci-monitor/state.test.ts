import assert from 'node:assert/strict';
import test from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import { emptyCiWatchState, readDedup, resetInlineFixConsecutiveAttempts } from './state.js';

test('resetInlineFixConsecutiveAttempts clears consecutive inline-fix window only', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'demo',
    ticketOrPr: `org/repo#${Date.now()}`,
  });
  t.after(async () => {
    if (getRun(run.id)) await deleteRun(run.id);
  });

  updateRun(run.id, {
    status: 'done',
    completedAt: new Date().toISOString(),
    ciWatchState: { ...emptyCiWatchState(), consecutiveAttempts: 2, totalAttempts: 5 },
  });
  resetInlineFixConsecutiveAttempts(run.id);

  const state = readDedup(run.id);
  assert.equal(state.consecutiveAttempts, 0);
  assert.equal(state.totalAttempts, 5);
});
