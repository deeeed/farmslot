import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { SlotActionSummary } from '@farmslot/protocol';

import {
  canRunSlotViewAction,
  slotViewActionsForPlacement,
} from './slot-view-slot-action-model.js';

const action = (id: string, placement: SlotActionSummary['placement']): SlotActionSummary => ({
  id,
  label: id,
  mode: 'run',
  style: 'secondary',
  placement,
  refresh: [],
});

test('slotViewActionsForPlacement filters slot actions by placement without reordering', () => {
  const actions = [
    action('header', ['slot-header']),
    action('both', ['resource-panel', 'slot-header']),
    action('resource', ['resource-panel']),
  ];
  assert.deepEqual(
    slotViewActionsForPlacement(actions, 'slot-header').map((entry) => entry.id),
    ['header', 'both'],
  );
  assert.deepEqual(
    slotViewActionsForPlacement(actions, 'resource-panel').map((entry) => entry.id),
    ['both', 'resource'],
  );
});

test('canRunSlotViewAction blocks missing, running, and recovery-blocked actions', () => {
  const runnable = action('copy', ['slot-header']);
  assert.equal(
    canRunSlotViewAction({ action: runnable, runningActionIds: [], recoveryBlocked: false }),
    true,
  );
  assert.equal(
    canRunSlotViewAction({ action: null, runningActionIds: [], recoveryBlocked: false }),
    false,
  );
  assert.equal(
    canRunSlotViewAction({ action: runnable, runningActionIds: ['copy'], recoveryBlocked: false }),
    false,
  );
  assert.equal(
    canRunSlotViewAction({ action: runnable, runningActionIds: [], recoveryBlocked: true }),
    false,
  );
});
