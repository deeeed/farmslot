import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import type { Run, RunDecision } from '@farmslot/protocol';

const prerequisites = await import('./gate-prerequisites.js');
const packages = await import('./publish-package-refresh.js');
// The live checks stand in for node reads that answer only when released.
let release!: () => void;
const released = new Promise<void>((resolve) => (release = resolve));
let checks = 0;
let finished = 0;
const readyPayload = {
  kind: 'ready' as const,
  prNumber: null,
  repo: null,
  branch: 'branch',
  diffStat: { files: 1, additions: 1, deletions: 0 },
  workerReport: 'Saved report',
};
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
    reconcilePublicationPackageForInspection: async (run: Run) => {
      finished++;
      return {
        ...run,
        decisions: run.decisions.map((decision) =>
          decision.resolvedAt
            ? decision
            : { ...decision, description: 'Collecting', payload: { ...readyPayload, stale: true } },
        ),
      };
    },
  },
});
const { GATE_INSPECTION_INTERVAL_MS } = await import('./gate-inspection.js');
const { createRun, deleteRun, getRun, updateRun } = await import('../runs/store.js');
const { runGet } = await import('../methods/run/context.js');
const { decisionList } = await import('../methods/decisions.js');
const { resourceRevisions } = await import('../resources/revisions.js');

const openGate = (id: string): RunDecision => ({
  id,
  type: 'engine_human_gate',
  title: 'Review changes',
  description: 'Stored',
  actions: [{ id: 'hold', label: 'Hold', style: 'secondary' }],
  createdAt: new Date().toISOString(),
  payload: { ...readyPayload },
});

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
    decisions: [openGate(`${run.id}-gate`)],
  });
}

const turn = () => new Promise((resolve) => setImmediate(resolve));
/** Wait for an observed condition, then let the check's own completion run; never a guessed delay. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 1_000 && !(await condition()); i++) await turn();
  assert.ok(await condition(), 'background check did not finish');
  await turn();
}
const settled = () => until(() => finished === checks);

/** Close the gate the way publication commits do: replaced decisions, in place, no timestamp. */
function closeInPlace(runId: string, ids = getRun(runId)!.decisions.map(({ id }) => id)): void {
  const run = getRun(runId)!;
  Object.assign(run, {
    decisions: run.decisions.map((decision) =>
      ids.includes(decision.id)
        ? { ...decision, resolvedAt: new Date().toISOString(), resolvedAction: 'approve-publish' }
        : decision,
    ),
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
  // The check's projection is announced, then served; the stored run is unchanged.
  await until(() => resourceRevisions.revision({ family: 'run', runId: run.id }) > before);
  assert.equal((await runGet({ runId: run.id })).run.decisions[0].description, 'Collecting');
  assert.equal(
    (await decisionList()).decisions.find((decision) => decision.id === gateId)?.description,
    'Collecting',
  );
  assert.equal(getRun(run.id)!.decisions[0].description, 'Stored');
  assert.equal(checks, 1, 'reads inside the interval start no check');

  // A writer that replaces the payload wins over the projection taken before it.
  updateRun(run.id, {
    decisions: getRun(run.id)!.decisions.map((decision) => ({
      ...decision,
      description: 'Refreshed',
      payload: { ...readyPayload },
    })),
  });
  assert.equal((await runGet({ runId: run.id })).run.decisions[0].description, 'Refreshed');
  assert.ok(GATE_INSPECTION_INTERVAL_MS >= 30_000);
});

test('a gate closed in place is never served from its projection', async (t) => {
  const run = gatedRun(t);
  const gateId = `${run.id}-gate`;
  // Publication adoption resolves the gate and keeps an unrelated open decision.
  updateRun(run.id, { decisions: [...run.decisions, openGate(`${run.id}-other`)] });
  const served = async () =>
    (await runGet({ runId: run.id })).run.decisions.find(({ id }) => id === gateId)!;
  await until(async () => (await served()).description === 'Collecting');
  closeInPlace(run.id, [gateId]);
  assert.ok((await served()).resolvedAt);
  assert.equal((await served()).description, 'Stored');
  assert.equal(
    (await decisionList()).decisions.some((decision) => decision.id === gateId),
    false,
  );
});

test('a read inside the interval gets one check at its end, and no read gets none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const run = gatedRun(t);
  const start = checks;
  await runGet({ runId: run.id });
  await settled();
  assert.equal(checks, start + 1);
  await runGet({ runId: run.id });
  await decisionList();
  assert.equal(checks, start + 1, 'paced');
  t.mock.timers.tick(GATE_INSPECTION_INTERVAL_MS);
  await settled();
  assert.equal(checks, start + 2, 'the trailing check ran');
  t.mock.timers.tick(GATE_INSPECTION_INTERVAL_MS);
  assert.equal(checks, start + 2, 'nothing read since');

  // A gate closed and reopened before its trailing check keeps one check in flight.
  await runGet({ runId: run.id });
  await settled();
  await runGet({ runId: run.id });
  closeInPlace(run.id);
  await runGet({ runId: run.id });
  updateRun(run.id, {
    decisions: [...getRun(run.id)!.decisions, openGate(`${run.id}-reopened`)],
  });
  await runGet({ runId: run.id });
  await settled();
  assert.equal(checks, start + 4, 'the reopened gate is checked at once');
  t.mock.timers.tick(GATE_INSPECTION_INTERVAL_MS);
  assert.equal(checks, start + 4, 'the closed gate left no trailing check');
  t.mock.timers.reset();
});
