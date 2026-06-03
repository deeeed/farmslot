import assert from 'node:assert/strict';
import test from 'node:test';

import { createRun, deleteRun, getRun, updateRun } from '../../runs/store.js';

import { runAutoRecoveryStop, runCIWatchPoke } from './engine-ops.js';

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) return;
  updateRun(runId, { status: 'done', completedAt: new Date().toISOString() });
  await deleteRun(runId);
}

test('runAutoRecoveryStop disables auto recovery and emits run update', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-auto-stop`,
  });
  t.after(() => cleanupRun(run.id));

  const events: string[] = [];
  const result = runAutoRecoveryStop({ runId: run.id }, (event) => {
    events.push(event);
  });

  assert.equal(result.run.autoRecoveryDisabled, true);
  assert.equal(result.run.recoveryProposal?.status, 'disabled');
  assert.deepEqual(events, ['run.updated']);
});

test('runCIWatchPoke surfaces missing runs before poking monitor state', () => {
  assert.throws(() => runCIWatchPoke({ runId: 'missing-ci-watch' }), /Run not found/);
});
