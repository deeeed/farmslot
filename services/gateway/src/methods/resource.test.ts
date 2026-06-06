import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import { slotAllowsDefaultResourceCleanup } from './resource.js';

function slot(
  overrides: Partial<SlotStatus>,
): Pick<SlotStatus, 'agent' | 'currentRunId' | 'lifecycle'> {
  return {
    agent: 'idle',
    currentRunId: null,
    lifecycle: 'ready',
    ...overrides,
  };
}

test('slotAllowsDefaultResourceCleanup excludes active or retained run slots', () => {
  assert.equal(slotAllowsDefaultResourceCleanup(slot({ lifecycle: 'ready' })), true);
  assert.equal(slotAllowsDefaultResourceCleanup(slot({ lifecycle: 'busy' })), false);
  assert.equal(slotAllowsDefaultResourceCleanup(slot({ lifecycle: 'held' })), false);
  assert.equal(slotAllowsDefaultResourceCleanup(slot({ agent: 'working' })), false);
  assert.equal(slotAllowsDefaultResourceCleanup(slot({ currentRunId: 'run-1' })), false);
});
