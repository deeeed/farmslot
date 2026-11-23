import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  acquireNativeWorkerRecovery,
  activePrepareSlots,
  assertNoNativeWorkerRecovery,
} from './native-worker-exclusion.js';

test('recovery holds its slot across async work and releases after failure', async () => {
  const slot = 'native-recovery-failure';
  const release = acquireNativeWorkerRecovery(slot);
  try {
    await Promise.resolve();
    assert.throws(() => assertNoNativeWorkerRecovery(slot), /active native worker recovery/);
    assert.throws(() => acquireNativeWorkerRecovery(slot), /active native worker recovery/);
    const otherRelease = acquireNativeWorkerRecovery('another-native-slot');
    otherRelease();
  } finally {
    release();
  }
  assert.doesNotThrow(() => assertNoNativeWorkerRecovery(slot));
});

test('already-admitted prepare refuses recovery until preparation exits', () => {
  const slot = 'native-prepare-first';
  activePrepareSlots.add(slot);
  try {
    assert.throws(() => acquireNativeWorkerRecovery(slot), /is preparing/);
  } finally {
    activePrepareSlots.delete(slot);
  }
  const release = acquireNativeWorkerRecovery(slot);
  release();
});

test('clearing a prepare guard is announced once, adding or missing ones are not', (t) => {
  const announced: string[] = [];
  t.after(activePrepareSlots.onCleared((slotId) => announced.push(slotId)));
  activePrepareSlots.add('slot-a');
  assert.deepEqual(announced, []);
  assert.equal(activePrepareSlots.delete('slot-a'), true);
  assert.equal(activePrepareSlots.delete('slot-a'), false);
  assert.deepEqual(announced, ['slot-a']);
});
