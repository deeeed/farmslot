import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

const SLOT = 'mini-mm-1';
const rows = new Map<string, Record<string, unknown>>();
const runs = new Map<string, Run>();

const state = await import('../core/state.js');
const claimSlotStatusIf: typeof state.claimSlotStatusIf = async (slotId, predicate, fields) => {
  const row = rows.get(slotId)!;
  if (!predicate(row)) return { claimed: false, epoch: null };
  const epoch = (Number(row.slot_epoch) || 0) + 1;
  rows.set(slotId, { ...row, ...fields, slot_epoch: epoch });
  return { claimed: true, epoch };
};
mock.module('../core/state.js', {
  namedExports: {
    ...state,
    readSlotRow: async (slotId: string) => rows.get(slotId) ?? null,
    claimSlotStatusIf,
  },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: { ...store, getRun: (id: string) => runs.get(id) },
});
const coordinator = await import('../run-lifecycle/transition-coordinator.js');
mock.module('../run-lifecycle/transition-coordinator.js', {
  namedExports: {
    ...coordinator,
    withRunTransition: <T>(_runId: string, operation: () => Promise<T>) => operation(),
  },
});
const { makeRun } = await import('./test-fixtures.js');
const { activeRunOnSlotReason } = await import('../methods/dispatch/slot-scoring.js');
const { claimWarmFallbackSlot } = await import('./dispatch-lifecycle-steps.js');

test('a warm child whose worker died claims its parent hold for the fresh launch', async () => {
  const child = makeRun({
    id: 'warm-child',
    slotId: SLOT,
    status: 'dispatching',
    parentRunId: 'parent-run',
    engineState: { generation: 0, flags: { warmSessionReuse: true, warmHandoffSucceeded: false } },
  });
  runs.set(child.id, child);
  rows.set(SLOT, {
    slot: SLOT,
    slot_epoch: 6,
    lifecycle: 'held',
    phase: 'occupied',
    current_run_id: null,
    cleanup_run_id: 'parent-run',
    handoff_run_id: null,
    held_reason: activeRunOnSlotReason(child.id),
    // The parent's idle cap stopped its dev server; the fresh launch must still restore it.
    idle_devserver_epoch: 6,
    idle_devservers: ['web'],
  });
  assert.equal(await claimWarmFallbackSlot(child, SLOT), true);
  const row = rows.get(SLOT)!;
  assert.equal(row.current_run_id, child.id, 'the fresh launch claim then sees its own run');
  assert.equal(row.lifecycle, 'busy');
  assert.equal(row.held_reason, null);
  assert.equal(row.cleanup_run_id, null);
  assert.equal(row.slot_epoch, 7);
  assert.equal(row.idle_devserver_epoch, 7, 'the idle marker stays current');

  // Any other hold still blocks the fallback, as before.
  rows.set(SLOT, {
    ...rows.get(SLOT)!,
    lifecycle: 'held',
    phase: 'occupied',
    current_run_id: null,
    cleanup_run_id: 'parent-run',
    held_reason: 'Process 4242 still uses the slot repository; slot teardown was skipped',
  });
  assert.equal(await claimWarmFallbackSlot(child, SLOT), false);
});
