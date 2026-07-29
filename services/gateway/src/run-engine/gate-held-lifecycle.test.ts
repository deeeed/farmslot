import assert from 'node:assert/strict';
import test from 'node:test';

import { PipelineSteps } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  blocksGateHeldSlotRelease,
  completeStepDisposition,
  findActiveGateHeldRunForSlot,
  isGateHeldPublicationRun,
  shouldKeepWorkerWarmThroughCiWatch,
  shouldTeardownGateHeldAgents,
} from './gate-held-lifecycle.js';
import { makeRun } from './test-fixtures.js';

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

function gateHeldRunPatch() {
  return {
    status: 'blocked' as const,
    steps: [
      {
        name: PipelineSteps.COMPLETE,
        status: 'done' as const,
        outputs: { slotDisposition: 'gate-held' },
      },
    ],
    decisions: [
      {
        id: 'decision-1',
        type: 'engine_human_gate' as const,
        title: 'Gate',
        description: 'Review package',
        actions: [],
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

test('isGateHeldPublicationRun is true for human-gating runs with gate-held complete output', () => {
  const run = makeRun({ flowType: 'dev', mode: 'autonomous', status: 'human-gating' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
  ];
  assert.equal(isGateHeldPublicationRun(run), true);
});

test('isGateHeldPublicationRun is true for blocked runs awaiting publication gate', () => {
  const run = makeRun({ flowType: 'dev', mode: 'autonomous', status: 'blocked' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
  ];
  run.decisions = [
    {
      id: 'decision-1',
      type: 'engine_human_gate',
      title: 'Gate',
      description: 'Review package',
      actions: [],
      createdAt: new Date().toISOString(),
    },
  ];
  assert.equal(isGateHeldPublicationRun(run), true);
});

test('isGateHeldPublicationRun is true for blocked runs with engine_review_posting decision', () => {
  const run = makeRun({ flowType: 'fix-bug', status: 'blocked' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
  ];
  run.decisions = [
    {
      id: 'decision-1',
      type: 'engine_review_posting',
      title: 'Posting',
      description: 'Review posting package',
      actions: [],
      createdAt: new Date().toISOString(),
    },
  ];
  assert.equal(isGateHeldPublicationRun(run), true);
});

test('isGateHeldPublicationRun is false after gate-held complete without open decision', () => {
  const run = makeRun({ flowType: 'fix-bug', status: 'blocked' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
  ];
  run.decisions = [
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
  ];
  assert.equal(isGateHeldPublicationRun(run), false);
});

test('completeStepDisposition reads COMPLETE step output', () => {
  const run = makeRun({ flowType: 'dev', mode: 'autonomous' });
  run.steps = [
    { name: PipelineSteps.COMPLETE, status: 'done', outputs: { slotDisposition: 'gate-held' } },
  ];
  assert.equal(completeStepDisposition(run), 'gate-held');
});

test('findActiveGateHeldRunForSlot returns active gate-held run for slot', async (t) => {
  const slotId = `gate-held-release-${Date.now()}`;
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-gate-held`,
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, gateHeldRunPatch());

  const found = findActiveGateHeldRunForSlot(slotId);
  assert.equal(found?.id, run.id);
});

test('blocksGateHeldSlotRelease stays true after gate approval until FINALIZE completes', () => {
  const run = makeRun({ flowType: 'dev', mode: 'autonomous', status: 'completing' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
    { name: PipelineSteps.FINALIZE, status: 'running' },
  ];
  run.decisions = [
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
  ];
  assert.equal(isGateHeldPublicationRun(run), false);
  assert.equal(blocksGateHeldSlotRelease(run), true);
});

test('blocksGateHeldSlotRelease is false after FINALIZE completes', () => {
  const run = makeRun({ flowType: 'fix-bug', status: 'ci-watching' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
    { name: PipelineSteps.FINALIZE, status: 'done' },
  ];
  assert.equal(blocksGateHeldSlotRelease(run), false);
});

test('shouldKeepWorkerWarmThroughCiWatch is true for gate-held publication runs', () => {
  const run = makeRun({ flowType: 'dev', mode: 'autonomous', slotId: 'macwork-ff-2' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
  ];
  assert.equal(shouldKeepWorkerWarmThroughCiWatch(run), true);
  assert.equal(shouldKeepWorkerWarmThroughCiWatch(makeRun({ flowType: 'review-pr' })), false);
});

test('shouldTeardownGateHeldAgents stays false for failed human-gate runs', () => {
  const run = makeRun({
    flowType: 'dev',
    mode: 'autonomous',
    slotId: 'macwork-ff-2',
    status: 'failed',
  });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
    { name: PipelineSteps.HUMAN_GATE, status: 'failed' },
  ];
  assert.equal(shouldTeardownGateHeldAgents(run), false);
});

test('shouldTeardownGateHeldAgents stays false after successful FINALIZE (warm through ci-watch)', () => {
  const run = makeRun({ flowType: 'fix-bug', slotId: 'macwork-ff-2', status: 'ci-watching' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
    { name: PipelineSteps.FINALIZE, status: 'done' },
  ];
  assert.equal(shouldTeardownGateHeldAgents(run), false);
});

test('shouldTeardownGateHeldAgents is true only on terminal failure after FINALIZE', () => {
  const run = makeRun({ flowType: 'fix-bug', slotId: 'macwork-ff-2', status: 'failed' });
  run.steps = [
    {
      name: PipelineSteps.COMPLETE,
      status: 'done',
      outputs: { slotDisposition: 'gate-held' },
    },
    { name: PipelineSteps.FINALIZE, status: 'done' },
  ];
  assert.equal(shouldTeardownGateHeldAgents(run), true);

  run.status = 'blocked';
  assert.equal(shouldTeardownGateHeldAgents(run), true);

  run.status = 'cancelled';
  assert.equal(shouldTeardownGateHeldAgents(run), true);

  run.status = 'done';
  assert.equal(shouldTeardownGateHeldAgents(run), false);
});

test('findActiveGateHeldRunForSlot ignores resolved gate-held runs', async (t) => {
  const slotId = `gate-held-resolved-${Date.now()}`;
  const run = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-resolved`,
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, {
    ...gateHeldRunPatch(),
    status: 'ci-watching',
    steps: [
      {
        name: PipelineSteps.COMPLETE,
        status: 'done',
        outputs: { slotDisposition: 'gate-held' },
      },
      { name: PipelineSteps.FINALIZE, status: 'done' },
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

  assert.equal(findActiveGateHeldRunForSlot(slotId), undefined);
});
