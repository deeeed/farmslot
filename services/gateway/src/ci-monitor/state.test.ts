import assert from 'node:assert/strict';
import test from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  autoDispatchSuppressed,
  emptyCiWatchState,
  readDedup,
  recordCIDecisionAction,
  resetInlineFixConsecutiveAttempts,
} from './state.js';

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

test('an operator choosing wait suppresses later automatic dispatch; other actions do not', async (t) => {
  // Run fcfb5124 (Mobile #39654): the operator chose "wait" at the
  // inline_fix_blocked gate, meaning wait for #40372 to merge. Nothing recorded
  // that choice, so the next poll found a merge conflict and auto-dispatched an
  // update-branch child, which also completed the parent. "wait" must leave a
  // mark that the automatic paths honour.
  const run = createRun({
    flowType: 'pr-complete',
    project: 'demo',
    ticketOrPr: `org/repo#${Date.now()}`,
  });
  t.after(async () => {
    if (getRun(run.id)) await deleteRun(run.id);
  });
  // deleteRun refuses an active run, so settle it the way the sibling test does.
  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });

  recordCIDecisionAction(run.id, 'wait');
  assert.ok(readDedup(run.id).operatorWaitAt, 'wait is recorded on the run');
  assert.equal(autoDispatchSuppressed(readDedup(run.id)), true);

  // The suppression is specific to wait: the dispatching and other control
  // actions must not set it, or a normal run would never auto-dispatch again.
  for (const actionId of ['retry', 'continue', 'dispatch-pr-complete', 'dispatch-update-branch']) {
    const other = createRun({
      flowType: 'pr-complete',
      project: 'demo',
      ticketOrPr: `org/repo#${Date.now()}-${actionId}`,
    });
    t.after(async () => {
      if (getRun(other.id)) await deleteRun(other.id);
    });
    updateRun(other.id, { status: 'done', completedAt: new Date().toISOString() });
    recordCIDecisionAction(other.id, actionId);
    assert.equal(
      autoDispatchSuppressed(readDedup(other.id)),
      false,
      `${actionId} must not suppress automatic dispatch`,
    );
  }
});
