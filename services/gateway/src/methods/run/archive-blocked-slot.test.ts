// @farmslot:serial — snapshots, overwrites, and restores the shared root `.farm-status.json`.
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { PipelineSteps, type Run, type SlotReleaseParams } from '@farmslot/protocol';

import { readSlotField, updateSlotStatus } from '../../core/index.js';
import { statusFile } from '../../core/state.js';
import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { runArchive } from './admin.js';

// The real-release case resolves the committed demo pool's slot.
process.env.FARMSLOT_DEMO_POOL = '1';

const slotId = 'demo-work-1';
const noopEmit = () => {};

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

/** What a fleet refresh writes for a blocked run's slot: held, owned by the run. */
async function holdSlotFor(t: test.TestContext, runId: string): Promise<void> {
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const data = priorStatus ? JSON.parse(priorStatus) : { slots: [] };
  const others = (data.slots ?? []).filter((row: { slot: string }) => row.slot !== slotId);
  const row = { slot: slotId, lifecycle: 'held', phase: 'pr-watch', current_run_id: runId };
  await writeFile(statusFile, JSON.stringify({ ...data, slots: [...others, row] }, null, 2) + '\n');
  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
  });
}

function blockedRun(t: test.TestContext, label: string, steps: Run['steps']): Run {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-${label}`,
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  return updateRun(run.id, { status: 'blocked', error: 'worker blocked', steps, decisions: [] });
}

test('archiving a settled blocked run that holds its slot releases the slot first', async (t) => {
  const run = blockedRun(t, 'archive-release', [{ name: 'monitor', status: 'done' }]);
  await holdSlotFor(t, run.id);
  const releases: SlotReleaseParams[] = [];

  const result = await runArchive({ runId: run.id }, noopEmit, async (params) => {
    releases.push(params);
    await updateSlotStatus(params.slotId, { current_run_id: null, lifecycle: 'ready' });
    return { released: true };
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(releases, [{ slotId, expectedRunId: run.id }]);
  assert.equal(await readSlotField(slotId, 'current_run_id'), null);
  assert.equal(getRun(run.id), undefined, 'the blocked run is archived');
});

test('a slot release guard refusing refuses the archive with its reason', async (t) => {
  const run = blockedRun(t, 'archive-guard', [{ name: 'monitor', status: 'done' }]);
  // A publication gate held on the same slot: the release's own guard refuses.
  const gated = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-archive-gate`,
    slotId,
  });
  t.after(() => cleanupRun(gated.id));
  updateRun(gated.id, {
    status: 'human-gating',
    steps: [
      { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
    ],
  });
  await holdSlotFor(t, run.id);

  await assert.rejects(
    runArchive({ runId: run.id }, noopEmit),
    new RegExp(`gate-held for run ${gated.id}`),
  );
  assert.equal(getRun(run.id)?.status, 'blocked', 'the run stays in the store, still blocked');
  assert.equal(getRun(run.id)?.slotId, slotId);
  assert.equal(await readSlotField(slotId, 'current_run_id'), run.id, 'slot still held');
});

test('archiving a live blocked run keeps refusing without touching its slot', async (t) => {
  const run = blockedRun(t, 'archive-live', [{ name: 'human-gate', status: 'running' }]);
  await holdSlotFor(t, run.id);
  let releaseCalls = 0;

  await assert.rejects(
    runArchive({ runId: run.id }, noopEmit, async () => {
      releaseCalls += 1;
      return { released: true };
    }),
    /Cannot archive active run/,
  );
  assert.equal(releaseCalls, 0);
  assert.equal(await readSlotField(slotId, 'current_run_id'), run.id);
  assert.ok(getRun(run.id));
});
