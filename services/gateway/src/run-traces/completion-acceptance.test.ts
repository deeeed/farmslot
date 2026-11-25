import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { AcceptanceStatusLedger } from '@farmslot/protocol';

const ledger: AcceptanceStatusLedger = {
  schemaVersion: 1,
  criteria: [{ id: 'ac-1', text: 'Opens', verdict: 'proven', evidence: [], recipeNodes: [] }],
};
let retained = true;
const retainedArtifacts = await import('../run-completion/retained-artifacts.js');
mock.module('../run-completion/retained-artifacts.js', {
  namedExports: {
    ...retainedArtifacts,
    retainedRunTaskDirectory: async () => {
      if (!retained) throw new Error('Run artifacts are not retained.');
      return '/retained/task';
    },
  },
});
const acceptance = await import('../tasks/acceptance-status.js');
mock.module('../tasks/acceptance-status.js', {
  namedExports: { ...acceptance, readAcceptanceStatusLedger: async () => ledger },
});
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { recordCompletionAcceptance } = await import('./output.js');

function endedRun() {
  const run = createRun({
    flowType: 'dev',
    mode: 'autonomous',
    project: 'farmslot-farm',
    ticketOrPr: `ACCEPT-${Date.now()}-${Math.random()}`,
  });
  updateRun(run.id, { status: 'done', completedAt: new Date().toISOString() });
  return run.id;
}

test('a run whose gate recorded no acceptance keeps the retained ledger as its snapshot', async (t) => {
  const runId = endedRun();
  t.after(() => deleteRun(runId));
  await recordCompletionAcceptance(runId);
  assert.deepEqual(getRun(runId)!.completionAcceptance, ledger);
});

test('without retained artifacts the snapshot stays unset and nothing throws', async (t) => {
  retained = false;
  const runId = endedRun();
  t.after(async () => {
    retained = true;
    await deleteRun(runId);
  });
  await recordCompletionAcceptance(runId);
  assert.equal(getRun(runId)!.completionAcceptance, undefined);
});
