import assert from 'node:assert/strict';
import test from 'node:test';

import { canSlotAcceptRecipeRerun } from './recipe-rerun-model.js';

test('canSlotAcceptRecipeRerun mirrors warm slot ownership checks', () => {
  assert.equal(
    canSlotAcceptRecipeRerun(
      { slot: 'slot-1', currentRunId: 'run-1', phase: 'review-gate' },
      {
        id: 'run-1',
        slotId: 'slot-1',
      },
    ),
    true,
  );
  assert.equal(
    canSlotAcceptRecipeRerun(
      { slot: 'slot-1', currentRunId: 'other', phase: 'review-gate' },
      {
        id: 'run-1',
        slotId: 'slot-1',
      },
    ),
    false,
  );
  assert.equal(
    canSlotAcceptRecipeRerun(
      { slot: 'slot-1', currentRunId: null, phase: 'review-gate' },
      {
        id: 'run-1',
        slotId: 'slot-1',
      },
    ),
    true,
  );
  assert.equal(
    canSlotAcceptRecipeRerun(
      { slot: 'slot-1', currentRunId: null, phase: 'ci-watch' },
      {
        id: 'run-1',
        slotId: 'slot-1',
      },
    ),
    false,
  );
});

test('canSlotAcceptRecipeRerun accepts held current-run slots', () => {
  assert.equal(
    canSlotAcceptRecipeRerun(
      { slot: 'slot-1', currentRunId: 'run-1', phase: 'ci-watch', lifecycle: 'held' },
      { id: 'run-1', slotId: 'slot-1' },
    ),
    true,
  );
});

test('canSlotAcceptRecipeRerun accepts a run-bound slot after a warm branch switch', () => {
  // Operator switched a warm slot to this run's branch (not at review-gate, not
  // held) — bound to the run and idle, so a recipe replay is allowed.
  assert.equal(
    canSlotAcceptRecipeRerun(
      { slot: 'slot-1', currentRunId: 'run-1', phase: null, lifecycle: 'ready' },
      { id: 'run-1', slotId: 'slot-1' },
    ),
    true,
  );
});

test('canSlotAcceptRecipeRerun rejects a run-bound slot that is mid-worker (busy)', () => {
  assert.equal(
    canSlotAcceptRecipeRerun(
      { slot: 'slot-1', currentRunId: 'run-1', phase: 'dispatch', lifecycle: 'busy' },
      { id: 'run-1', slotId: 'slot-1' },
    ),
    false,
  );
});
