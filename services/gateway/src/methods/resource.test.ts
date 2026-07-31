import assert from 'node:assert/strict';
import test from 'node:test';

import type { SlotStatus } from '@farmslot/protocol';

import { SlotConfigError } from '../core/config.js';

import {
  isUnresolvableSlotError,
  resolvePressureSlotResources,
  slotAllowsDefaultResourceCleanup,
} from './resource.js';

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

test('a slot the fleet lists but slot-config cannot resolve is skipped, not fatal', () => {
  assert.equal(
    isUnresolvableSlotError(new SlotConfigError('SLOT_NOT_FOUND', "Slot 'x' not found")),
    true,
  );
  // Matches slot-config's PROJECT_CONFIG_NOT_FOUND_PREFIX, the case this helper
  // already tolerated before SLOT_NOT_FOUND was added.
  assert.equal(
    isUnresolvableSlotError(new Error('Project config not found: /pool/demo.json')),
    true,
  );
});

test('other slot-config failures still propagate', () => {
  // Only "this slot is not resolvable right now" is tolerable. A broken pool
  // directory or an unreadable repo is a real fault and must not be swallowed.
  for (const code of ['POOL_DIR_NOT_FOUND', 'REPO_DIR_NOT_FOUND', 'INVALID_POOL']) {
    assert.equal(
      isUnresolvableSlotError(new SlotConfigError(code, `boom: ${code}`)),
      false,
      `${code} must propagate`,
    );
  }
  assert.equal(isUnresolvableSlotError(new Error('ECONNRESET')), false);
  assert.equal(isUnresolvableSlotError('not an error'), false);
});

test('resolvePressureSlotResources returns no resources for an unresolvable slot', async () => {
  // Real error path: this id exists in no pool JSON, which is exactly the case
  // the fleet snapshot hits for a gated pool (pool/farmslot-demo.json needs
  // FARMSLOT_DEMO_POOL=1). It must not throw.
  const resources = await resolvePressureSlotResources(
    `definitely-not-a-slot-${process.pid}-${process.hrtime.bigint()}`,
  );
  assert.deepEqual(resources, []);
});
