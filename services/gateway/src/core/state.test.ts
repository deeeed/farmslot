import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import {
  claimSlotStatusIf,
  markSlotStatusIf,
  resetSlotIf,
  SLOT_PHASE_RELEASING,
  statusFile,
  updateSlotStatusIf,
} from './state.js';

async function withStatusFixture(
  t: { after: (fn: () => Promise<void>) => void },
  slot: Record<string, unknown>,
): Promise<string> {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  await writeFile(statusFile, JSON.stringify({ slots: [slot] }, null, 2) + '\n');
  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
  });
  return String(slot.slot);
}

async function readSlotFixture(slotId: string): Promise<Record<string, unknown>> {
  const data = JSON.parse(await readFile(statusFile, 'utf8'));
  return data.slots.find((s: { slot: string }) => s.slot === slotId);
}

test('claimSlotStatusIf applies fields and bumps the ownership epoch atomically', async (t) => {
  const slotId = await withStatusFixture(t, {
    slot: 'epoch-test-1',
    lifecycle: 'ready',
    slot_epoch: 4,
  });

  const claim = await claimSlotStatusIf(slotId, () => true, {
    lifecycle: 'busy',
    phase: 'dispatching',
  });

  assert.equal(claim.claimed, true);
  assert.equal(claim.epoch, 5);
  const after = await readSlotFixture(slotId);
  assert.equal(after.slot_epoch, 5);
  assert.equal(after.phase, 'dispatching');
});

test('a predicate-refused claim neither writes nor bumps the epoch', async (t) => {
  const slotId = await withStatusFixture(t, {
    slot: 'epoch-test-2',
    lifecycle: 'busy',
    phase: SLOT_PHASE_RELEASING,
    slot_epoch: 7,
  });

  const claim = await claimSlotStatusIf(slotId, (slot) => slot.phase !== SLOT_PHASE_RELEASING, {
    lifecycle: 'busy',
    phase: 'dispatching',
  });

  assert.equal(claim.claimed, false);
  assert.equal(claim.epoch, null);
  const after = await readSlotFixture(slotId);
  assert.equal(after.slot_epoch, 7);
  assert.equal(after.phase, SLOT_PHASE_RELEASING);
});

test('a teardown write guarded on a stale epoch is rejected after a rival claim', async (t) => {
  const slotId = await withStatusFixture(t, {
    slot: 'epoch-test-3',
    lifecycle: 'busy',
    phase: SLOT_PHASE_RELEASING,
    current_run_id: 'run-a',
    slot_epoch: 1,
  });
  // Teardown captured epoch 1; a rival claim then bumps it.
  const teardownEpoch = 1;
  await claimSlotStatusIf(slotId, () => true, {
    lifecycle: 'busy',
    phase: 'dispatching',
    current_run_id: 'run-b',
  });

  const wrote = await updateSlotStatusIf(
    slotId,
    (slot) => (Number(slot.slot_epoch) || 0) === teardownEpoch,
    { lifecycle: 'ready', current_run_id: null },
  );

  assert.equal(wrote, false, 'the stale teardown must not clobber the rival claim');
  const after = await readSlotFixture(slotId);
  assert.equal(after.current_run_id, 'run-b');
  assert.equal(after.lifecycle, 'busy');
});

test('markSlotStatusIf validates, marks, and captures the epoch in one write (no bump)', async (t) => {
  const slotId = await withStatusFixture(t, {
    slot: 'epoch-test-4',
    lifecycle: 'busy',
    phase: 'working',
    current_run_id: 'run-a',
    slot_epoch: 3,
  });

  const mark = await markSlotStatusIf(slotId, (slot) => slot.current_run_id === 'run-a', {
    phase: SLOT_PHASE_RELEASING,
  });

  assert.deepEqual(mark, { applied: true, epoch: 3 });
  const after = await readSlotFixture(slotId);
  assert.equal(after.phase, SLOT_PHASE_RELEASING);
  assert.equal(after.slot_epoch, 3, 'teardown marks never bump the epoch');

  // Owner validation and marking are the same write: a mismatched owner
  // refuses without touching anything.
  const refused = await markSlotStatusIf(slotId, (slot) => slot.current_run_id === 'run-b', {
    phase: 'working',
  });
  assert.deepEqual(refused, { applied: false, epoch: null });
});

test('resetSlotIf applies the ready/idle reset only while its predicate holds', async (t) => {
  const slotId = await withStatusFixture(t, {
    slot: 'epoch-test-5',
    lifecycle: 'busy',
    phase: SLOT_PHASE_RELEASING,
    current_run_id: 'run-a',
    slot_epoch: 2,
  });

  // Rival claim bumps the epoch mid-teardown.
  await claimSlotStatusIf(slotId, () => true, {
    lifecycle: 'busy',
    phase: 'dispatching',
    current_run_id: 'run-b',
  });
  const blocked = await resetSlotIf(slotId, (slot) => (Number(slot.slot_epoch) || 0) === 2);
  assert.equal(blocked, false);
  let after = await readSlotFixture(slotId);
  assert.equal(after.current_run_id, 'run-b', 'rival claim survives');

  const allowed = await resetSlotIf(slotId, (slot) => (Number(slot.slot_epoch) || 0) === 3);
  assert.equal(allowed, true);
  after = await readSlotFixture(slotId);
  assert.equal(after.lifecycle, 'ready');
  assert.equal(after.current_run_id, null);
});
