import assert from 'node:assert/strict';
import test from 'node:test';

import type { FamilyObservabilityRunSummary, SlotStatus } from '@farmslot/protocol';

import { familySlotForRun, familyWarmSlotRerunCheck } from './family-observability-rerun-model.js';

function run(
  overrides: Partial<FamilyObservabilityRunSummary> = {},
): FamilyObservabilityRunSummary {
  return {
    runId: 'run-1',
    slotId: 'slot-1',
    ...overrides,
  } as FamilyObservabilityRunSummary;
}

function slot(overrides: Partial<SlotStatus> = {}): SlotStatus {
  return {
    slot: 'slot-1',
    currentRunId: 'run-1',
    lifecycle: 'busy',
    phase: 'review-gate',
    ...overrides,
  } as SlotStatus;
}

test('familySlotForRun resolves the slot currently holding the run', () => {
  assert.equal(
    familySlotForRun([slot({ currentRunId: 'other' }), slot()], 'run-1')?.slot,
    'slot-1',
  );
  assert.equal(familySlotForRun([slot({ currentRunId: 'other' })], 'run-1'), null);
  assert.equal(familySlotForRun([slot()], undefined), null);
});

test('familyWarmSlotRerunCheck preserves family observability rerun reasons', () => {
  assert.deepEqual(familyWarmSlotRerunCheck(null, []), {
    ok: false,
    reason: 'no run selected',
  });
  assert.deepEqual(familyWarmSlotRerunCheck(run(), []), {
    ok: false,
    reason: 'slot not found (may have been released)',
  });
  assert.deepEqual(
    familyWarmSlotRerunCheck(run(), [slot({ lifecycle: 'busy', phase: 'ci-watch' })]),
    {
      ok: false,
      reason: 'slot slot-1 not in review-gate (busy / ci-watch)',
    },
  );
});

test('familyWarmSlotRerunCheck accepts review-gate and held current-run slots', () => {
  assert.deepEqual(familyWarmSlotRerunCheck(run(), [slot()]), { ok: true, slotId: 'slot-1' });
  assert.deepEqual(
    familyWarmSlotRerunCheck(run(), [slot({ lifecycle: 'held', phase: 'ci-watch' })]),
    { ok: true, slotId: 'slot-1' },
  );
});
