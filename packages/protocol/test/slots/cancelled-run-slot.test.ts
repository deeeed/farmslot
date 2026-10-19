import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { Run, RunStep } from '../../src/contracts/runs.js';
import type { SlotStatus } from '../../src/contracts/slots.js';
import type { SlotReleaseParams } from '../../src/rpc/slot.js';
import {
  CANCELLED_RUN_SLOT_RELEASE_TIMEOUT_MS,
  cancelledRunHoldReason,
  cancelledRunSlotChoices,
  cancelledRunSlotHold,
  releaseCancelledRunSlot,
} from '../../src/slots/cancelled-run-slot.js';

const RUN_ID = '3f2a9c1e-5b7d-4e2a-9c1e-5b7d4e2a9c1e';

type HoldSlot = Pick<SlotStatus, 'slot' | 'lifecycle' | 'phase' | 'currentRunId' | 'heldReason'>;

function keptSlot(overrides: Partial<HoldSlot> = {}): HoldSlot {
  return {
    slot: 'macpro-mmt-1',
    lifecycle: 'held',
    phase: 'occupied',
    currentRunId: RUN_ID,
    heldReason: cancelledRunHoldReason(RUN_ID),
    ...overrides,
  };
}

function step(name: string, status: RunStep['status'], startedAt?: string): RunStep {
  return { name, status, ...(startedAt ? { startedAt } : {}) };
}

function cancelledRun(overrides: Partial<Pick<Run, 'id' | 'status' | 'steps'>> = {}) {
  return {
    id: RUN_ID,
    status: 'cancelled' as const,
    // Cancel marks the running step and every pending one skipped; only the
    // stopped one has a start time.
    steps: [
      step('prepare', 'done', '2026-10-19T14:00:00Z'),
      step('dev', 'done', '2026-10-19T14:02:00Z'),
      step('review', 'skipped', '2026-10-19T14:20:00Z'),
      step('human-gate', 'skipped'),
    ],
    ...overrides,
  };
}

test('a slot kept for a cancelled run offers the release run.delete does', () => {
  assert.deepEqual(cancelledRunSlotHold(keptSlot()), {
    slotId: 'macpro-mmt-1',
    runId: RUN_ID,
    label: 'held by cancelled run 3f2a9c1e',
    releaseLabel: 'Release slot',
    releaseConfirm:
      "Release macpro-mmt-1? This resets its checkout and discards the cancelled run's local work.",
    releaseParams: { slotId: 'macpro-mmt-1', expectedRunId: RUN_ID, forceReset: true },
  });
});

test('only the cancel hold of the slot owner counts', () => {
  for (const slot of [
    keptSlot({ lifecycle: 'busy' }),
    keptSlot({ phase: 'releasing' }),
    keptSlot({ heldReason: 'Workspace occupied by pid 44809' }),
    keptSlot({ heldReason: cancelledRunHoldReason('another-run') }),
    keptSlot({ currentRunId: null }),
  ])
    assert.equal(cancelledRunSlotHold(slot), null, JSON.stringify(slot));
});

test('the run view offers replay from the stopped step beside the release', () => {
  const fleet = [keptSlot({ slot: 'macpro-mmt-2', currentRunId: null }), keptSlot()];
  const choices = cancelledRunSlotChoices(cancelledRun(), fleet);
  assert.equal(choices?.hold.slotId, 'macpro-mmt-1');
  assert.equal(choices?.replayStepName, 'review');
  assert.equal(choices?.replayLabel, 'Replay from review');
});

test('the run view offers nothing once the slot is released or the run moved on', () => {
  assert.equal(cancelledRunSlotChoices(cancelledRun(), []), null);
  assert.equal(
    cancelledRunSlotChoices(cancelledRun(), [keptSlot({ lifecycle: 'ready', phase: null })]),
    null,
  );
  assert.equal(cancelledRunSlotChoices(cancelledRun({ status: 'reviewing' }), [keptSlot()]), null);
});

test('the release sends the reset release and reports a refusal', async () => {
  const hold = cancelledRunSlotHold(keptSlot());
  if (!hold) return assert.fail('the kept slot has no hold');
  const sent: Array<[string, SlotReleaseParams, number]> = [];
  assert.equal(
    await releaseCancelledRunSlot(async (method, params, timeoutMs) => {
      sent.push([method, params, timeoutMs]);
      return { released: true };
    }, hold),
    null,
  );
  assert.deepEqual(sent, [
    [
      'slot.release',
      { slotId: 'macpro-mmt-1', expectedRunId: RUN_ID, forceReset: true },
      CANCELLED_RUN_SLOT_RELEASE_TIMEOUT_MS,
    ],
  ]);
  assert.equal(
    await releaseCancelledRunSlot(
      async () => ({ released: false, reason: 'Slot macpro-mmt-1 is held by run other' }),
      hold,
    ),
    'Slot macpro-mmt-1 is held by run other',
  );
});
