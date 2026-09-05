import assert from 'node:assert/strict';
import test from 'node:test';

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

  const detached = detachRunsForReleasedSlot('macwork-mm-release-test', (event) =>
    events.push(event),
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

  const detached = detachRunsForReleasedSlot(slotId, () => {});

  // Only the occupant this release tore down loses its binding. The parked
  // run's slotId is its restore target and its preserved-branch key.
  assert.deepEqual(detached, [successor.id]);
  assert.equal(getRun(successor.id)!.slotId, null);
  assert.equal(getRun(parked.id)!.slotId, slotId);
  assert.equal(getRun(parked.id)!.park?.slotFreedAt, freedAt);
});
