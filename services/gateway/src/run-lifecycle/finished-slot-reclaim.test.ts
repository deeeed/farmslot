import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { makeRun } from '../run-engine/test-fixtures.js';
import { makeVars } from '../runners/test-fixtures.js';

import type { SafeIdleSlotResult } from './safe-idle-slot.js';

const SLOT = 'mini-core-2';
let row: Record<string, unknown> | null;
let runs: Run[];
let idleReturn: SafeIdleSlotResult;
let released: { released: boolean; reason?: string };
const cleared: string[] = [];

const core = await import('../core/index.js');
mock.module('../core/index.js', {
  namedExports: {
    ...core,
    readSlotRow: async () => row,
    loadSlotVars: async () => makeVars(),
    loadProjectVars: async () => ({ projectJson: { default_branch: 'main' } }),
    execOnSlot: async () => ({ exitCode: 0, stdout: 'fix/previous\n', stderr: '' }),
  },
});
const tracking = await import('../methods/slot/slot-tracking.js');
mock.module('../methods/slot/slot-tracking.js', {
  namedExports: { ...tracking, detectLinkedWorktree: async () => false },
});
const store = await import('../runs/store.js');
mock.module('../runs/store.js', {
  namedExports: { ...store, getAllRunsWithArchived: async () => runs },
});
const safeIdle = await import('./safe-idle-slot.js');
mock.module('./safe-idle-slot.js', {
  namedExports: { ...safeIdle, reuseSafeIdleSlot: async () => idleReturn },
});
const release = await import('../methods/slot/release.js');
mock.module('../methods/slot/release.js', {
  namedExports: { ...release, slotRelease: async () => released },
});
const teardown = await import('./slot-teardown.js');
mock.module('./slot-teardown.js', {
  namedExports: {
    ...teardown,
    clearCheckoutRetainedNote: async (run: Run) => void cleared.push(run.id),
  },
});
const { reclaimFinishedSlot } = await import('./finished-slot-reclaim.js');

const finished = makeRun({
  id: 'finished',
  project: 'core',
  status: 'done',
  slotId: SLOT,
  branch: 'fix/previous',
});
const incoming = { id: 'incoming', project: 'core', branch: 'fix/next' };

beforeEach(() => {
  runs = [finished];
  idleReturn = { kind: 'ready' };
  released = { released: true };
  cleared.length = 0;
});

test('an ownerless finished checkout returned to idle drops its stale note', async () => {
  row = { current_run_id: null, slot_epoch: 3 };
  await reclaimFinishedSlot(SLOT, incoming, () => {});
  assert.deepEqual(cleared, ['finished']);
});

test('an owner-bound finished checkout released drops its stale note', async () => {
  row = { current_run_id: 'finished', slot_epoch: 3 };
  await reclaimFinishedSlot(SLOT, incoming, () => {});
  assert.deepEqual(cleared, ['finished']);
});

test('a refused reclaim keeps the note', async () => {
  row = { current_run_id: null, slot_epoch: 3 };
  idleReturn = { kind: 'unavailable', reason: 'Slot is working' };
  await assert.rejects(
    reclaimFinishedSlot(SLOT, incoming, () => {}),
    /Slot is working/,
  );
  row = { current_run_id: 'finished', slot_epoch: 3 };
  released = { released: false, reason: 'unmerged work' };
  await assert.rejects(
    reclaimFinishedSlot(SLOT, incoming, () => {}),
    /unmerged work/,
  );
  assert.deepEqual(cleared, []);
});
