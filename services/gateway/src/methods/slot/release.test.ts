import assert from 'node:assert/strict';
import test from 'node:test';

import { PipelineSteps } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { slotRelease } from './release.js';

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
    project: 'farmslot',
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
    project: 'farmslot',
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
    project: 'farmslot',
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
