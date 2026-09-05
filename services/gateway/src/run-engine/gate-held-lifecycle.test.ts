import assert from 'node:assert/strict';
import test from 'node:test';

import { type MachineParkRecord, PipelineSteps } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../runs/store.js';

import {
  blocksGateHeldSlotRelease,
  completeStepDisposition,
  findActiveGateHeldRunForSlot,
  findGateParkedRunForSlot,
  isGateHeldPublicationRun,
  isSlotFreedByPark,
  parkFreedSlotIds,
  shouldKeepWorkerWarmThroughCiWatch,
  shouldTeardownGateHeldAgents,
} from './gate-held-lifecycle.js';
import { postureForBoundary } from './resource-posture.js';
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

test('a gate-held run waits under operator-wait, the one posture that cannot stop a worker', async (t) => {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'test-project',
    ticketOrPr: 'MANUAL-1',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, { ...gateHeldRunPatch(), slotId: 'slot-a' });

  const held = getRun(run.id)!;
  assert.equal(isGateHeldPublicationRun(held), true);
  assert.equal(blocksGateHeldSlotRelease(held), true);
  assert.equal(shouldTeardownGateHeldAgents(held), false);

  // ADR-038 under ADR-054: the durable wait a gate-held run sits in maps to
  // `operator-wait`. `parked` is the only posture that stops a worker at all,
  // and it is reachable only through machine-pause eligibility, which excludes
  // gate-held runs.
  assert.equal(postureForBoundary('operator-wait'), 'operator-wait');
  assert.equal(postureForBoundary('gate-resolved'), 'operator-wait');
  assert.notEqual(postureForBoundary('operator-wait'), 'parked');
});

// ─── ADR-054 free-slot at an operator wait ───

function freedGateParkRecord(runId: string, slotId: string): MachineParkRecord {
  return {
    version: 1,
    operationId: `park-${runId}`,
    previewId: `preview-${runId}`,
    runId,
    generation: 0,
    machine: 'machine-a',
    slotId,
    mode: 'release',
    phase: 'parked',
    slotDisposition: 'freed',
    slotFreedAt: new Date().toISOString(),
    prePauseStatus: 'blocked',
    prePauseCurrentStep: { index: 1, name: PipelineSteps.HUMAN_GATE, status: 'running' },
    resourceManifest: { capturedAt: new Date().toISOString(), resources: [], capabilityLeases: [] },
    recoveryHandle: null,
    errors: [],
    residuals: { runner: 'stopped', resources: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

test('isSlotFreedByPark keys on the recorded release, not the park intent', () => {
  const record = freedGateParkRecord('run-1', 'slot-1');
  assert.equal(isSlotFreedByPark({ park: record }), true);
  assert.equal(isSlotFreedByPark({ park: { ...record, slotFreedAt: undefined } }), false);
  assert.equal(isSlotFreedByPark({ park: null }), false);
  assert.equal(isSlotFreedByPark({}), false);
});

test('a gate-parked run leaves findActiveGateHeldRunForSlot and moves to the park lookup', async (t) => {
  const slotId = `gate-parked-release-${Date.now()}`;
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-gate-parked`,
    slotId,
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, gateHeldRunPatch());

  // Still holding the slot: it blocks release and has no park lookup entry.
  assert.equal(findActiveGateHeldRunForSlot(slotId)?.id, run.id);
  assert.equal(findGateParkedRunForSlot(slotId), undefined);

  updateRun(run.id, { park: freedGateParkRecord(run.id, slotId) });

  // Freed: the run no longer occupies the slot, but its record is protected.
  assert.equal(findActiveGateHeldRunForSlot(slotId), undefined);
  assert.equal(findGateParkedRunForSlot(slotId)?.id, run.id);
});

test('parkFreedSlotIds lists exactly the slots an automated sweep must leave alone', async (t) => {
  const parkedSlot = `park-freed-sweep-${Date.now()}`;
  const busySlot = `park-busy-sweep-${Date.now()}`;
  const parked = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-sweep-parked`,
    slotId: parkedSlot,
  });
  const holding = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `PROJ-${Date.now()}-sweep-holding`,
    slotId: busySlot,
  });
  t.after(() => cleanupRun(parked.id));
  t.after(() => cleanupRun(holding.id));
  updateRun(parked.id, {
    ...gateHeldRunPatch(),
    park: freedGateParkRecord(parked.id, parkedSlot),
  });
  // Same gate-held shape, but its park never released the slot.
  updateRun(holding.id, {
    ...gateHeldRunPatch(),
    park: { ...freedGateParkRecord(holding.id, busySlot), slotFreedAt: undefined },
  });

  const ids = parkFreedSlotIds();

  assert.equal(ids.has(parkedSlot), true);
  assert.equal(ids.has(busySlot), false, 'a park that kept its slot is not a swept-over slot');
});
