import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

test("the orphan reconciler's pass hands its fleet snapshot and active slots to the idle prune", async () => {
  const { reconcileOrphanedSlots } = await import('./recovery.js');
  const calls: Array<{ slots: string[]; active: string[] }> = [];
  const active: Pick<Run, 'id' | 'status' | 'slotId'> = { id: 'run-1', status: 'running', slotId: 'busy-1' };
  await reconcileOrphanedSlots({
    listRuns: () => ({ runs: [active as Run] }),
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
