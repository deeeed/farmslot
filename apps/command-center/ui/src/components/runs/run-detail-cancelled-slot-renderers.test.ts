import assert from 'node:assert/strict';
import test from 'node:test';

import { nothing } from 'lit';

import {
  cancelledRunHoldReason,
  cancelledRunSlotChoices,
  type CancelledRunSlotHold,
  type Run,
} from '@farmslot/protocol';

import { litBinding } from '../../testing/lit-text.js';
import type { CancelledRunSlotReplay } from '../shared/cancelled-run-slot-release.js';

import { renderCancelledRunSlotChoices } from './run-detail-cancelled-slot-renderers.js';
import { canReplayRunSteps } from './run-detail-model.js';

const RUN_ID = '3f2a9c1e-5b7d-4e2a-9c1e-5b7d4e2a9c1e';

const cancelledRun: Run = {
  id: RUN_ID,
  familyId: 'family-1',
  lane: 'production',
  flowType: 'fix-bug',
  status: 'cancelled',
  project: 'farmslot-farm',
  ticketOrPr: 'BUG-123',
  slotId: 'macpro-mmt-1',
  branch: 'fix/BUG-123',
  taskFile: null,
  steps: [
    { name: 'dev', status: 'done', startedAt: '2026-10-19T14:02:00Z' },
    { name: 'review', status: 'skipped', startedAt: '2026-10-19T14:20:00Z' },
    { name: 'human-gate', status: 'skipped' },
  ],
  decisions: [],
  metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5.4' },
  createdAt: '2026-10-19T14:00:00.000Z',
  updatedAt: '2026-10-19T14:25:00.000Z',
};

const keptSlot = {
  slot: 'macpro-mmt-1',
  lifecycle: 'held' as const,
  phase: 'occupied' as const,
  currentRunId: RUN_ID,
  heldReason: cancelledRunHoldReason(RUN_ID),
};

function isHold(value: unknown): value is CancelledRunSlotHold {
  return typeof value === 'object' && value !== null && 'releaseParams' in value;
}

function isReplay(value: unknown): value is CancelledRunSlotReplay {
  return typeof value === 'object' && value !== null && 'onReplay' in value;
}

test('the run view offers replay and the reset release side by side on a kept slot', () => {
  const replays: unknown[][] = [];
  const view = renderCancelledRunSlotChoices(cancelledRun, {
    choices: cancelledRunSlotChoices(cancelledRun, [keptSlot]),
    replayAllowed: canReplayRunSteps(cancelledRun),
    onReplayStep: (...args) => {
      replays.push(args);
    },
  });

  const hold = litBinding(view, '.hold=');
  if (!isHold(hold)) return assert.fail('the release has no hold');
  assert.equal(hold.releaseLabel, 'Release slot');
  assert.deepEqual(hold.releaseParams, {
    slotId: 'macpro-mmt-1',
    expectedRunId: RUN_ID,
    forceReset: true,
  });

  const replay = litBinding(view, '.replay=');
  if (!isReplay(replay)) return assert.fail('the run view has no replay choice');
  assert.equal(replay.label, 'Replay from review');
  assert.equal(replay.disabled, false);
  replay.onReplay();
  assert.deepEqual(replays, [['review', undefined, undefined, false]]);
});

test('the run view offers neither once the slot is released', () => {
  const released = { ...keptSlot, lifecycle: 'ready' as const, phase: null, heldReason: '' };
  assert.equal(
    renderCancelledRunSlotChoices(cancelledRun, {
      choices: cancelledRunSlotChoices(cancelledRun, [released]),
      replayAllowed: true,
      onReplayStep: () => assert.fail('no replay without the choices'),
    }),
    nothing,
  );
});
