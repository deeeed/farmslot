import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '@farmslot/protocol';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { detachRunsForReleasedSlot } from './release-run-ownership.js';

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

test('detachRunsForReleasedSlot preserves blocked run state while freeing slot ownership', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-release`,
    slotId: 'macwork-mm-release-test',
    runner: 'claude',
    model: 'opus',
  });
  t.after(() => cleanupRun(run.id));
  updateRun(run.id, { status: 'blocked' });
  const events: string[] = [];

  const detached = detachRunsForReleasedSlot(
    'macwork-mm-release-test',
    (event) => events.push(event),
    run.id,
  );

  assert.deepEqual(detached, [run.id]);
  const updated = getRun(run.id)!;
  assert.equal(updated.status, 'blocked');
  assert.equal(updated.slotId, null);
  assert.deepEqual(events, ['run.updated']);
});

test('a successor release does not detach the park record that freed the slot', async (t) => {
  const slotId = `macwork-mm-park-detach-${Date.now()}`;
  const parked = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-parked`,
    slotId,
    runner: 'claude',
    model: 'opus',
  });
  const successor = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-successor`,
    slotId,
    runner: 'claude',
    model: 'opus',
  });
  t.after(() => cleanupRun(parked.id));
  t.after(() => cleanupRun(successor.id));
  const freedAt = new Date().toISOString();
  updateRun(parked.id, {
    status: 'human-gating',
    park: {
      version: 1,
      operationId: 'park-detach',
      previewId: 'preview-detach',
      runId: parked.id,
      generation: 1,
      machine: 'macwork',
      slotId,
      mode: 'release',
      phase: 'parked',
      slotDisposition: 'freed',
      slotFreedAt: freedAt,
      preservedWorkspace: { branch: 'work/parked', headSha: 'sha-parked', detachedAt: freedAt },
      prePauseStatus: 'human-gating',
      prePauseCurrentStep: { index: 1, name: 'human-gate', status: 'running' },
      resourceManifest: { capturedAt: freedAt, resources: [], capabilityLeases: [] },
      recoveryHandle: null,
      errors: [],
      residuals: { runner: 'stopped', resources: [] },
      createdAt: freedAt,
      updatedAt: freedAt,
    },
  });
  updateRun(successor.id, { status: 'monitoring' });

  const detached = detachRunsForReleasedSlot(slotId, () => {}, successor.id);

  // Only the occupant this release tore down loses its binding. The parked
  // run's slotId is its restore target and its preserved-branch key.
  assert.deepEqual(detached, [successor.id]);
  assert.equal(getRun(successor.id)!.slotId, null);
  assert.equal(getRun(parked.id)!.slotId, slotId);
  assert.equal(getRun(parked.id)!.park?.slotFreedAt, freedAt);
});

test('a release keeps the explicit pick of a run still waiting in find-slot for that slot', async (t) => {
  const slotId = `macwork-mm-waiter-detach-${Date.now()}`;
  const runOn = (label: string) => {
    const run = createRun({
      flowType: 'dev',
      project: 'example-mobile-farm',
      ticketOrPr: `PROJ-${Date.now()}-${label}`,
      slotId,
      runner: 'claude',
      model: 'opus',
    });
    t.after(() => cleanupRun(run.id));
    return run;
  };
  const withFindSlot = (run: Run, status: Run['steps'][number]['status']) =>
    updateRun(run.id, {
      steps: run.steps.map((step) => (step.name === 'find-slot' ? { ...step, status } : step)),
    });
  const owner = runOn('owner');
  updateRun(owner.id, { status: 'blocked' });
  // A blocked run past find-slot that the row no longer names still held the slot.
  const bound = withFindSlot(runOn('bound'), 'done');
  updateRun(bound.id, { status: 'blocked' });
  // An explicit `--slot` dispatch parked in find-slot until this release lands.
  const waiter = withFindSlot(runOn('waiter'), 'running');
  updateRun(waiter.id, { status: 'slot-finding' });

  const detached = detachRunsForReleasedSlot(slotId, () => {}, owner.id);

  assert.deepEqual(detached.sort(), [owner.id, bound.id].sort());
  assert.equal(getRun(owner.id)!.slotId, null, 'the released owner is detached');
  assert.equal(getRun(bound.id)!.slotId, null);
  assert.equal(getRun(waiter.id)!.slotId, slotId, 'the waiter still targets the slot it asked for');
});
