import assert from 'node:assert/strict';
import test from 'node:test';

import { PipelineSteps } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { slotRelease } from './release.js';

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
  // Self-contained slot row: CI status files have no demo rows, and the
  // status helpers no-op on missing slots.
  const { readFile, rm, writeFile } = await import('node:fs/promises');
  const { statusFile } = await import('../../core/state.js');
  const { readSlotField } = await import('../../core/index.js');
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const data = priorStatus ? JSON.parse(priorStatus) : { slots: [] };
  const others = (data.slots ?? []).filter((row: { slot: string }) => row.slot !== slotId);
  await writeFile(
    statusFile,
    JSON.stringify(
      {
        ...data,
        slots: [
          ...others,
          { slot: slotId, lifecycle: 'busy', phase: 'working', current_run_id: rival.id },
        ],
      },
      null,
      2,
    ) + '\n',
  );
  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
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
