import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { replaySlotReclaimCheck } from '../run/replay-step.js';

import {
  activeRunOnSlotReason,
  parentHoldForWarmChild,
  slotClaimBlockedByRelease,
  warmChildAwaitsParentRow,
  type WarmChildClaimant,
} from './slot-scoring.js';
import { warmHandoffClaimBlocker } from './warm-session-handoff.js';

const SLOT = 'mini-mm-1';
// 12afdc85 chained c616be16: the child was writing its task when the parent's cleanup ran.
const child: WarmChildClaimant = {
  id: 'c616be16',
  status: 'dispatching',
  slotId: SLOT,
  parentRunId: '12afdc85',
  engineState: { generation: 0, flags: { warmSessionReuse: true } },
};
const parentHold = {
  slot: SLOT,
  lifecycle: 'held' as const,
  phase: 'occupied' as const,
  current_run_id: null,
  cleanup_run_id: '12afdc85',
  handoff_run_id: null,
  held_reason: activeRunOnSlotReason('c616be16'),
};

test('the warm child may claim the hold its parent left for it; nobody else may', () => {
  assert.equal(parentHoldForWarmChild(parentHold, child), true);
  assert.equal(slotClaimBlockedByRelease(parentHold, child), null);
  assert.equal(warmHandoffClaimBlocker(parentHold, child), null);
  assert.equal(slotClaimBlockedByRelease(parentHold), 'occupied');
  assert.equal(slotClaimBlockedByRelease(parentHold, { ...child, id: 'rival' }), 'occupied');
});

// Guards: each is refused on main too; they pin what the child may not take.
for (const [what, row, claimant] of [
  [
    'a census hold the parent left',
    {
      ...parentHold,
      held_reason: 'Process 4242 still uses the slot repository; slot teardown was skipped',
    },
    child,
  ],
  ['a hold another run left', { ...parentHold, cleanup_run_id: 'someone-else' }, child],
  [
    'a hold naming another child',
    { ...parentHold, held_reason: activeRunOnSlotReason('x') },
    child,
  ],
  ['a hold whose stop is unconfirmed', { ...parentHold, cleanup_stop_unconfirmed: true }, child],
  [
    'a hold under a release fence',
    { ...parentHold, releasing_since: '2026-11-24T17:07:13Z' },
    child,
  ],
  ['a hold another run reserved', { ...parentHold, handoff_run_id: 'rival' }, child],
  ['a finished child', parentHold, { ...child, status: 'failed' }],
  ['a child without warm reuse', parentHold, { ...child, engineState: { generation: 0 } }],
  ['a child pinned elsewhere', parentHold, { ...child, slotId: 'mini-mm-2' }],
] as const)
  test(`the warm child may not claim ${what}`, () => {
    assert.equal(parentHoldForWarmChild(row, claimant), false);
    assert.notEqual(warmHandoffClaimBlocker(row, claimant), null);
  });

test('a warm child awaits its parent row while the parent owns it or owns its cleanup', () => {
  const owned = { slot: SLOT, lifecycle: 'busy', current_run_id: '12afdc85' };
  assert.equal(warmChildAwaitsParentRow(child, owned), true);
  assert.equal(warmChildAwaitsParentRow(child, parentHold), true);
  assert.equal(warmChildAwaitsParentRow(child, { ...owned, current_run_id: child.id }), false);
  assert.equal(warmChildAwaitsParentRow(child, { ...owned, current_run_id: 'other' }), false);
  assert.equal(
    warmChildAwaitsParentRow({ ...child, engineState: { generation: 0 } }, owned),
    false,
  );
});

test("a replay of the warm child is refused on its parent's hold (pinned, not handled)", () => {
  assert.deepEqual(replaySlotReclaimCheck(parentHold, child.id), {
    ok: false,
    reason: 'not-reclaimable',
    lifecycle: 'held',
  });
});

test('warm handoff checks its claim before the pressure gate and the prompt delivery', () => {
  const source = readFileSync(path.join(import.meta.dirname, 'warm-session-handoff.ts'), 'utf8');
  const check = source.indexOf('if (blockedBeforeDelivery) throw refuseClaim(');
  const baseline = source.indexOf('await recordRetainedPrBaseline(');
  const delivery = source.indexOf('await deliverPromptWithRetainedFallback(');
  assert.ok(check > 0, 'a claim check precedes delivery');
  assert.ok(check < baseline && baseline < delivery);
});
