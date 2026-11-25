import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  createRun,
  discardUndurableRun,
  getRun,
  persistRunNow,
  timeRunSlotRelease,
} from './store.js';

test('a release that frees the slot records its duration on the run; one that does not records nothing', async (t) => {
  const run = createRun({ flowType: 'fix-bug', project: 'demo', ticketOrPr: randomUUID() });
  t.after(async () => {
    if (!getRun(run.id)) return;
    await persistRunNow(run);
    await discardUndurableRun(run.id);
  });

  const kept = await timeRunSlotRelease(run.id, 'slot-a', async () => ({ released: false }));
  assert.deepEqual(kept, { released: false });
  assert.equal(getRun(run.id)?.slotRelease, undefined);

  const before = Date.now();
  await timeRunSlotRelease(run.id, 'slot-a', async () => {
    await delay(20);
    return { released: true };
  });
  const record = getRun(run.id)?.slotRelease;
  assert.equal(record?.slotId, 'slot-a');
  assert.ok(record.durationMs >= 15, `release took ${record.durationMs}ms`);
  assert.ok(Date.parse(record.startedAt) >= before - 5);
});

test('a failed release keeps its error and records nothing', async (t) => {
  const run = createRun({ flowType: 'dev', project: 'demo', ticketOrPr: randomUUID() });
  t.after(async () => {
    if (!getRun(run.id)) return;
    await persistRunNow(run);
    await discardUndurableRun(run.id);
  });
  const failure = new Error('teardown failed');
  await assert.rejects(
    timeRunSlotRelease(run.id, 'slot-a', () => Promise.reject(failure)),
    failure,
  );
  assert.equal(getRun(run.id)?.slotRelease, undefined);
});

test('a release that measured itself records its phases with the duration', async (t) => {
  const run = createRun({ flowType: 'fix-bug', project: 'demo', ticketOrPr: randomUUID() });
  t.after(async () => {
    if (!getRun(run.id)) return;
    await persistRunNow(run);
    await discardUndurableRun(run.id);
  });
  const bundleLock = { acquisitions: 2, waitMs: 3, heldMs: 40 };
  await timeRunSlotRelease(
    run.id,
    'slot-a',
    async () => ({ released: true }),
    () => ({ phasesMs: { queue: 5, resources: 120 }, bundleLock }),
  );
  const record = getRun(run.id)?.slotRelease;
  assert.deepEqual(record?.phasesMs, { queue: 5, resources: 120 });
  assert.deepEqual(record?.bundleLock, bundleLock);
  assert.equal(record?.slotId, 'slot-a');
});
