import assert from 'node:assert/strict';
import test from 'node:test';

import { cancelledRunHoldReason } from '../../../../../packages/protocol/src/slots/cancelled-run-slot';

import { offeredSlotRelease } from './run-slot-release';

const run = {
  id: 'run-1',
  status: 'cancelled' as const,
  steps: [{ name: 'monitor', status: 'failed' as const, startedAt: '2026-11-02T00:00:00.000Z' }],
};
const slots = [
  {
    slot: 'slot-1',
    lifecycle: 'held' as const,
    phase: 'occupied' as const,
    currentRunId: 'run-1',
    heldReason: cancelledRunHoldReason('run-1'),
  },
];

test('a cancelled run holding its slot is offered the release only while run.get is actionable', () => {
  assert.equal(offeredSlotRelease(run, slots, false), null);
  assert.deepEqual(offeredSlotRelease(run, slots, true)?.hold.releaseParams, {
    slotId: 'slot-1',
    expectedRunId: 'run-1',
    forceReset: true,
  });
});
