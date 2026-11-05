import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Run } from '@farmslot/protocol';

const prerequisites = await import('./gate-prerequisites.js');
const packages = await import('./publish-package-refresh.js');
// The live checks stand in for node reads that answer only when released.
let release!: () => void;
const released = new Promise<void>((resolve) => (release = resolve));
let checks = 0;
mock.module('./gate-prerequisites.js', {
  namedExports: {
    ...prerequisites,
    refreshRunGateReadiness: async (run: Run) => {
      checks++;
      await released;
      return run;
    },
  },
});
mock.module('./publish-package-refresh.js', {
  namedExports: {
    ...packages,
    // A package still collecting is projected onto the gate, never stored.
    reconcilePublicationPackageForInspection: async (run: Run) => ({
      ...run,
      decisions: run.decisions.map((decision) => ({ ...decision, description: 'Collecting' })),
    }),
  },
});
const { GATE_INSPECTION_INTERVAL_MS } = await import('./gate-inspection.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { runGet } = await import('../methods/run/context.js');
const { decisionList } = await import('../methods/decisions.js');
const { resourceRevisions } = await import('../resources/revisions.js');

function gatedRun(t: import('node:test').TestContext): Run {
  const run = createRun({
    flowType: 'dev',
    project: 'farmslot-farm',
    mode: 'interactive',
    ticketOrPr: `GATE-INSPECTION-${Date.now()}`,
    initialContext: 'Open publish gate',
  });
  t.after(async () => {
    updateRun(run.id, { status: 'failed', completedAt: new Date().toISOString() });
    await deleteRun(run.id);
  });
  return updateRun(run.id, {
    status: 'human-gating',
    slotId: 'gate-inspection-slot',
    decisions: [
      {
        id: `${run.id}-gate`,
        type: 'engine_human_gate',
        title: 'Review changes',
        description: 'Stored',
        actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
        createdAt: run.createdAt,
      },
    ],
  });
}

const within = <T>(read: Promise<T>) =>
  Promise.race([read, delay(1_000).then(() => 'waited for live checks' as const)]);

test('gate reads serve the stored run while one paced background check runs', async (t) => {
  t.after(() => release());
  const run = gatedRun(t);
  const gateId = `${run.id}-gate`;
  const before = resourceRevisions.revision({ family: 'run', runId: run.id });
  // Concurrent reads answer at once from the stored run and share one live check.
  const reads = await Promise.all([
    within(runGet({ runId: run.id })),
    within(decisionList()),
    within(runGet({ runId: run.id })),
  ]);
  assert.notEqual(reads[0], 'waited for live checks');
  assert.notEqual(reads[1], 'waited for live checks');
  assert.equal((reads[0] as { run: Run }).run.decisions[0].description, 'Stored');
  assert.equal(checks, 1);

  release();
  await delay(10);
  // The check's projection is served and announced; the stored run is unchanged.
  assert.equal((await runGet({ runId: run.id })).run.decisions[0].description, 'Collecting');
  assert.equal(
    (await decisionList()).decisions.find((decision) => decision.id === gateId)?.description,
    'Collecting',
  );
  assert.equal(getRun(run.id)!.decisions[0].description, 'Stored');
  assert.ok(resourceRevisions.revision({ family: 'run', runId: run.id }) > before);
  assert.equal(checks, 1, 'reads inside the interval start no check');

  // A stored change wins over the projection taken before it.
  updateRun(run.id, { summary: 'changed' });
  assert.equal((await runGet({ runId: run.id })).run.decisions[0].description, 'Stored');
  assert.ok(GATE_INSPECTION_INTERVAL_MS >= 30_000);
});

test('a read inside the interval gets one check at its end, and no read gets none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const run = gatedRun(t);
  const start = checks;
  await runGet({ runId: run.id });
  await settle();
  assert.equal(checks, start + 1);
  await runGet({ runId: run.id });
  await decisionList();
  await settle();
  assert.equal(checks, start + 1, 'paced');
  t.mock.timers.tick(GATE_INSPECTION_INTERVAL_MS);
  await settle();
  assert.equal(checks, start + 2, 'the trailing check ran');
  t.mock.timers.tick(GATE_INSPECTION_INTERVAL_MS);
  await settle();
  assert.equal(checks, start + 2, 'nothing read since');
  t.mock.timers.reset();
});
