import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

// The ledger write is the await a writer can replace the card during.
let duringLedgerWrite: (() => void) | undefined;
const router = await import('../intelligence/learnings-router.js');
mock.module('../intelligence/learnings-router.js', {
  namedExports: {
    ...router,
    recordLearningsDraftLanded: async () => {
      duringLedgerWrite?.();
      return [];
    },
  },
});
const { runResolveDecision } = await import('./run.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');

test('a card replaced during the ledger write still gets the resolution writes', async (t) => {
  const run = createRun({ flowType: 'pr-complete', project: 'farmslot-farm', ticketOrPr: 'o/r#8' });
  t.after(async () => {
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  const card: RunDecision = {
    id: 'learnings-replaced',
    type: 'engine_learnings_draft',
    title: 'Learnings draft',
    description: 'A card another writer replaces while the ledger is written',
    actions: [{ id: 'landed', label: 'Landed', style: 'primary' }],
    createdAt: new Date().toISOString(),
    payload: {
      kind: 'learnings-draft',
      project: 'farmslot-farm',
      sourceRunId: run.id,
      drafts: [],
      holds: [],
    },
  };
  updateRun(run.id, { decisions: [card] });
  // An unresolved card swapped by id, as the refused-replay reopen does.
  duringLedgerWrite = () => {
    const current = getRun(run.id)!;
    updateRun(run.id, {
      decisions: current.decisions.map((entry) => (entry.id === card.id ? { ...entry } : entry)),
    });
  };
  t.after(() => {
    duringLedgerWrite = undefined;
  });

  const selectionData = { dir: `/farm/support/${'f'.repeat(64)}` };
  await runResolveDecision(
    { runId: run.id, decisionId: card.id, actionId: 'landed', selectionData },
    () => {},
  );

  const stored = getRun(run.id)!.decisions.find((decision) => decision.id === card.id)!;
  assert.equal(stored.resolvedAction, 'landed');
  assert.deepEqual(stored.selectionData, selectionData, 'the stored card holds the selection');
});
