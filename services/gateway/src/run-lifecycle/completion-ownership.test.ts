import assert from 'node:assert/strict';
import test from 'node:test';

import '../runtime/mock-pty.test-support.js';

import { hasHadTerminalCleanup } from '../methods/runtime-capabilities.js';
import { archiveRun, createRun, deleteRun, getRun, listRuns, updateRun } from '../runs/store.js';

test('the production store retains failed completion for admission, eviction and runtime recovery', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'completion-ownership',
    ticketOrPr: 'OWNER-123',
  });
  t.after(async () => {
    if (getRun(run.id)) {
      updateRun(run.id, { status: 'done' });
      await deleteRun(run.id);
    }
  });
  const held = updateRun(run.id, {
    status: 'failed',
    slotId: 'retained-slot',
    steps: [{ name: 'complete', status: 'failed', outputs: { gatePrerequisiteRefusal: {} } }],
  });
  assert.ok(listRuns({ active: true }).runs.some((entry) => entry.id === run.id));
  assert.equal(hasHadTerminalCleanup(held), false);
  await assert.rejects(deleteRun(run.id), /Cannot delete active run/);
  await assert.rejects(archiveRun(run.id), /Cannot archive active run/);
  updateRun(run.id, { status: 'done' });
  assert.equal(hasHadTerminalCleanup(getRun(run.id)!), true);
  assert.equal(
    listRuns({ active: true }).runs.some((entry) => entry.id === run.id),
    false,
  );
  assert.equal(await deleteRun(run.id), true);
});
