import assert from 'node:assert/strict';
import test from 'node:test';

import { PipelineSteps } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { releaseOwnershipIntact, slotRelease } from './release.js';

// These tests resolve the committed demo pool's slots (demo-work-1), which the
// loaders hide unless explicitly opted in.
process.env.FARMSLOT_DEMO_POOL = '1';

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

const noopEmit = () => {};

test('slotRelease rejects gate-held publication runs before teardown', async (t) => {
  const slotId = 'demo-work-1';
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-release-guard`,
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'blocked',
    steps: [
      {
        name: PipelineSteps.COMPLETE,
        status: 'done',
        outputs: { slotDisposition: 'gate-held' },
      },
    ],
    decisions: [
      {
        id: 'decision-1',
        type: 'engine_human_gate',
        title: 'Gate',
        description: 'Review package',
        actions: [],
        createdAt: new Date().toISOString(),
      },
    ],
  });

  await assert.rejects(
    () => slotRelease({ slotId }, noopEmit),
    new RegExp(`gate-held for run ${run.id}`),
  );
});

test('slotRelease rejects human-gating gate-held runs before teardown', async (t) => {
  const slotId = 'demo-work-1';
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-human-gating`,
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'human-gating',
    steps: [
      {
        name: PipelineSteps.COMPLETE,
        status: 'done',
        outputs: { slotDisposition: 'gate-held' },
      },
    ],
  });

  await assert.rejects(
    () => slotRelease({ slotId }, noopEmit),
    new RegExp(`gate-held for run ${run.id}`),
  );
});

test('slotRelease rejects post-approval gate-held runs until FINALIZE completes', async (t) => {
  const slotId = 'demo-work-1';
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-finalize-guard`,
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'completing',
    steps: [
      {
        name: PipelineSteps.COMPLETE,
        status: 'done',
        outputs: { slotDisposition: 'gate-held' },
      },
      { name: PipelineSteps.FINALIZE, status: 'running' },
    ],
    decisions: [
      {
        id: 'decision-1',
        type: 'engine_human_gate',
        title: 'Gate',
        description: 'Review package',
        actions: [],
        createdAt: new Date().toISOString(),
        resolvedAt: new Date().toISOString(),
        resolvedAction: 'approve-publish',
      },
    ],
  });

  await assert.rejects(
    () => slotRelease({ slotId }, noopEmit),
    new RegExp(`gate-held for run ${run.id}`),
  );
});

test('releaseOwnershipIntact only allows teardown while the entry owner still holds the slot', () => {
  // Unchanged owner (or an unclaimed slot released as unclaimed) may proceed.
  assert.equal(releaseOwnershipIntact({ current_run_id: 'run-a' }, 'run-a'), true);
  assert.equal(releaseOwnershipIntact({}, null), true);
  // A rival claim landing after release entry owns the slot now: killing its
  // session and resetting its claim would leave a zombie worker.
  assert.equal(releaseOwnershipIntact({ current_run_id: 'run-b' }, 'run-a'), false);
  assert.equal(releaseOwnershipIntact({ current_run_id: 'run-b' }, null), false);
  // Owner vanished (already released elsewhere): nothing to protect.
  assert.equal(releaseOwnershipIntact({}, 'run-a'), false);
});

test('slotRelease with expectedRunId leaves a slot held by a different run untouched', async (t) => {
  const slotId = 'demo-work-1';
  const rival = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-owner-binding`,
    slotId,
  });
  t.after(() => cleanupRun(rival.id));
  const { updateSlotStatus, readSlotField } = await import('../../core/index.js');
  const priorOwner = await readSlotField(slotId, 'current_run_id');
  await updateSlotStatus(slotId, { current_run_id: rival.id });
  t.after(async () => {
    await updateSlotStatus(slotId, { current_run_id: priorOwner ?? null });
  });

  const result = await slotRelease({ slotId, expectedRunId: 'some-other-run' }, noopEmit);

  assert.deepEqual(result, { released: false });
  assert.equal(await readSlotField(slotId, 'current_run_id'), rival.id, 'claim untouched');
});

test('concurrent slotRelease calls for one slot coalesce onto a single in-flight teardown', async (t) => {
  const slotId = 'demo-work-1';
  // Reuse the gate-held rejection path: both callers must observe the SAME
  // teardown attempt (one underlying promise), not two parallel teardowns.
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-coalesce`,
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    status: 'blocked',
    steps: [
      { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
    ],
    decisions: [
      {
        id: 'decision-coalesce',
        type: 'engine_human_gate',
        title: 'Gate',
        description: 'Review package',
        actions: [],
        createdAt: new Date().toISOString(),
      },
    ],
  });

  const first = slotRelease({ slotId }, noopEmit);
  const second = slotRelease({ slotId }, noopEmit);
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'rejected');
  // Coalesced: both callers surfaced the SAME underlying failure.
  assert.equal(
    (results[0] as PromiseRejectedResult).reason,
    (results[1] as PromiseRejectedResult).reason,
  );
});
