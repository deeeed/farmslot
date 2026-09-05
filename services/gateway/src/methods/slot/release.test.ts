// @farmslot:serial — snapshots, overwrites, and restores the shared root `.farm-status.json`.
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

test('slotRelease bound to the owner still refuses a slot already mid-release', async (t) => {
  const slotId = 'demo-work-1';
  const owner = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-releasing-fence`,
    slotId,
  });
  t.after(() => cleanupRun(owner.id));
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
          // An in-flight teardown owns this slot; a bound release joining at
          // the same epoch would run a second destructive pass.
          { slot: slotId, lifecycle: 'busy', phase: 'releasing', current_run_id: owner.id },
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

  const result = await slotRelease({ slotId, expectedRunId: owner.id }, noopEmit);

  assert.deepEqual(result, { released: false });
  assert.equal(await readSlotField(slotId, 'phase'), 'releasing', 'fence untouched');
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

// ─── ADR-054 free-slot at an operator wait ───

function freedGateParkRecord(runId: string, slotId: string) {
  return {
    version: 1 as const,
    operationId: `park-${runId}`,
    previewId: `preview-${runId}`,
    runId,
    generation: 1,
    machine: 'demo',
    slotId,
    mode: 'release' as const,
    phase: 'parked' as const,
    slotDisposition: 'freed' as const,
    slotFreedAt: new Date().toISOString(),
    prePauseStatus: 'human-gating' as const,
    prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' as const },
    resourceManifest: {
      capturedAt: new Date().toISOString(),
      resources: [],
      capabilityLeases: [],
    },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped' as const, resources: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function seedSlotRow(
  t: { after: (fn: () => void | Promise<void>) => void },
  slotId: string,
  row: Record<string, unknown>,
): Promise<void> {
  const { readFile, rm, writeFile } = await import('node:fs/promises');
  const { statusFile } = await import('../../core/state.js');
  const priorStatus = await readFile(statusFile, 'utf8').catch(() => null);
  const data = priorStatus ? JSON.parse(priorStatus) : { slots: [] };
  const others = (data.slots ?? []).filter((entry: { slot: string }) => entry.slot !== slotId);
  await writeFile(
    statusFile,
    JSON.stringify({ ...data, slots: [...others, { slot: slotId, ...row }] }, null, 2) + '\n',
  );
  t.after(async () => {
    if (priorStatus == null) await rm(statusFile, { force: true });
    else await writeFile(statusFile, priorStatus);
  });
}

test('slotRelease refuses to destroy a gate-parked run park record on the freed slot', async (t) => {
  const slotId = 'demo-work-1';
  const parked = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-park-guard`,
    slotId,
  });
  t.after(() => cleanupRun(parked.id));
  updateRun(parked.id, {
    status: 'human-gating',
    steps: [
      { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
      { name: PipelineSteps.HUMAN_GATE, status: 'running' },
    ],
    park: freedGateParkRecord(parked.id, slotId),
  });
  // The park released ownership, so the row is ready and unowned.
  await seedSlotRow(t, slotId, {
    lifecycle: 'ready',
    phase: null,
    agent: 'idle',
    current_run_id: null,
  });

  await assert.rejects(
    () => slotRelease({ slotId }, noopEmit),
    new RegExp(`park record for gate-parked run ${parked.id}`),
  );
});

test('slotRelease still releases the new occupant of a slot a gate park freed', async (t) => {
  const slotId = 'demo-work-1';
  const parked = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-park-successor`,
    slotId,
  });
  const occupant = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-park-successor-new`,
    slotId,
  });
  t.after(() => cleanupRun(parked.id));
  t.after(() => cleanupRun(occupant.id));
  updateRun(parked.id, {
    status: 'human-gating',
    steps: [
      { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
      { name: PipelineSteps.HUMAN_GATE, status: 'running' },
    ],
    park: freedGateParkRecord(parked.id, slotId),
  });
  updateRun(occupant.id, { status: 'monitoring' });
  // The successor claimed the freed slot.
  await seedSlotRow(t, slotId, {
    lifecycle: 'busy',
    phase: 'working',
    agent: 'working',
    current_run_id: occupant.id,
  });

  await assert.rejects(
    () => slotRelease({ slotId }, noopEmit),
    (error: Error) => {
      // The park guard let this release through. It then stops at the next
      // check in slotReleaseImpl — the operator-root safety assert, which the
      // committed demo pool's `"repo": "."` slot always trips — instead of
      // running a destructive teardown inside this test.
      assert.doesNotMatch(error.message, /park record for gate-parked run/);
      assert.match(error.message, /operator root/);
      return true;
    },
  );
});
