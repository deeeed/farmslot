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
