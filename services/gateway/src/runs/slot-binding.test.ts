import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureRunSlotBinding } from './slot-binding.js';
import { createRun, deleteRun, getRun, updateRun } from './store.js';

test('ensureRunSlotBinding restores slotId from find-slot selectedSlot', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, {
    slotId: null,
    steps: run.steps.map((step) =>
      step.name === 'find-slot'
        ? {
            ...step,
            status: 'done',
            outputs: { selectedSlot: 'macwork-ff-4', runner: 'grok', model: 'grok-build' },
          }
        : step,
    ),
  });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const bound = ensureRunSlotBinding(run.id);
  assert.equal(bound.slotId, 'macwork-ff-4');
  assert.equal(getRun(run.id)?.slotId, 'macwork-ff-4');
});

test('ensureRunSlotBinding is a no-op when slotId is already set', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  updateRun(run.id, { slotId: 'macwork-ff-1' });

  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
      await deleteRun(run.id);
    }
  });

  const bound = ensureRunSlotBinding(run.id);
  assert.equal(bound.slotId, 'macwork-ff-1');
});
