import assert from 'node:assert/strict';
import test from 'node:test';

import '../core/private-pool.test-support.js';

test("the orphan reconciler's pass hands its fleet snapshot and active slots to the idle prune", async (t) => {
  const { reconcileOrphanedSlots } = await import('./recovery.js');
  const calls: Array<{ slots: string[]; active: string[] }> = [];
  const { createRun, deleteRun, updateRun } = await import('../runs/store.js');
  const created = createRun({ flowType: 'dev', project: 'fixture', ticketOrPr: 'TAT-1' }, { deferBackgroundPersist: true });
  const active = updateRun(created.id, { status: 'dispatching', slotId: 'busy-1' })!;
  t.after(async () => {
    updateRun(active.id, { status: 'done', completedAt: new Date().toISOString() });
    await deleteRun(active.id);
  });
  await reconcileOrphanedSlots({
    listRuns: () => ({ runs: [active] }),
    loadFleetStatus: async () => ({
      slots: [
        { slot: 'idle-1', lifecycle: 'ready', phase: null, currentRunId: null },
        { slot: 'busy-1', lifecycle: 'busy', phase: 'working', currentRunId: 'run-1' },
      ],
    }),
    isTerminalTeardownInFlight: () => false,
    readSlotField: async () => undefined,
    getRun: () => undefined,
    updateRun: () => {},
    resetSlot: async () => {},
    resetSlotIf: async () => false,
    updateSlotStatusIf: async () => false,
    broadcast: () => {},
    retryOccupiedRunSlot: async () => false,
    resumeInterruptedRecovery: () => {},
    pruneIdleRemoteRefs: (slots, activeSlotIds) =>
      calls.push({ slots: slots.map((slot) => slot.slot), active: [...activeSlotIds] }),
  });
  assert.deepEqual(calls, [{ slots: ['idle-1', 'busy-1'], active: ['busy-1'] }]);
});
