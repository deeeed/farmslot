import assert from 'node:assert/strict';
import test from 'node:test';

import type { RunDecision } from '@farmslot/protocol';

const { runResolveDecision } = await import('./run.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { referencedNodeSupportHashes } = await import('../node-support/activation.js');

const supportRoot = '/farm/support';
const hash = 'e'.repeat(64);

test('a refused learnings-draft resolution leaves the stored decision and its support scan unchanged', async (t) => {
  const run = createRun({ flowType: 'pr-complete', project: 'farmslot-farm', ticketOrPr: 'o/r#7' });
  t.after(async () => {
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  // No destination: recording the card as landed throws after the resolution started.
  const card: RunDecision = {
    id: 'learnings-refused',
    type: 'engine_learnings_draft',
    title: 'Learnings draft',
    description: 'A card whose ledger write fails',
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
  // The inventory has scanned the run before the refused call.
  assert.deepEqual(referencedNodeSupportHashes([getRun(run.id)!], supportRoot), []);

  await assert.rejects(
    runResolveDecision(
      {
        runId: run.id,
        decisionId: card.id,
        actionId: 'landed',
        selectionData: { dir: `${supportRoot}/${hash}` },
      },
      () => {},
    ),
    /no canonical destination/,
  );

  const stored = getRun(run.id)!.decisions.find((decision) => decision.id === card.id)!;
  assert.equal(stored.resolvedAt, undefined);
  assert.equal(stored.selectionData, undefined, 'a refusal writes nothing to the stored card');
  assert.deepEqual(referencedNodeSupportHashes([getRun(run.id)!], supportRoot), []);
});
