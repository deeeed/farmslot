import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let readHead = async () => 'a'.repeat(40);
mock.module('../review/acceptance-coverage.js', {
  namedExports: { readPRCompletionHead: () => readHead() },
});
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { assertPRCompletionIdentity } = await import('./pr-completion-proof.js');

for (const change of ['none', 'head', 'revision', 'pause', 'cancel'] as const) {
  test(`${change} during a head read preserves completion identity`, async (t) => {
    const run = createRun({
      flowType: 'pr-complete',
      project: 'generic-project',
      ticketOrPr: 'example/repo#1',
    });
    t.after(async () => {
      updateRun(run.id, { status: 'failed', slotId: null });
      await deleteRun(run.id);
    });
    updateRun(run.id, {
      status: 'completing',
      acceptanceContractVersion: 1,
      acceptanceExecutionContract: {
        schemaVersion: 1,
        runId: run.id,
        revision: 1,
        registrationRevision: 0,
        baseContractHash: 'b'.repeat(64),
        proofModes: [],
        inheritedCriterionIds: [],
      },
    });
    const identity = {
      generation: getRun(run.id)!.engineState?.generation ?? 0,
      registrationRevision: 0,
      contractRevision: 1,
      headSha: 'a'.repeat(40),
    };
    readHead = async () => {
      if (change === 'head') return 'b'.repeat(40);
      if (change === 'revision')
        updateRun(run.id, {
          acceptanceExecutionContract: {
            ...getRun(run.id)!.acceptanceExecutionContract!,
            revision: 2,
          },
        });
      if (change === 'pause' || change === 'cancel')
        updateRun(run.id, { status: change === 'pause' ? 'paused' : 'cancelled' });
      return identity.headSha;
    };
    if (change === 'none') await assertPRCompletionIdentity(run.id, identity);
    else
      await assert.rejects(
        assertPRCompletionIdentity(run.id, identity),
        /acceptance or pushed head changed/,
      );
  });
}
