import assert from 'node:assert/strict';
import test from 'node:test';

import { runnerDefaultSafetyTier } from '../runners/registry.js';

import {
  backfillLegacySafetyTier,
  cleanupRuns,
  createRun,
  deleteRun,
  getRun,
  isSyntheticLeak,
  listRuns,
  normalizeRunClassification,
  shouldUseIsolatedRunsDir,
  updateRun,
} from './store.js';

async function cleanupRun(runId: string): Promise<void> {
  if (!getRun(runId)) {
    return;
  }
  updateRun(runId, {
    status: 'done',
    completedAt: new Date().toISOString(),
  });
  await deleteRun(runId);
}

test('shouldUseIsolatedRunsDir detects node --test and direct tsx test entrypoints', () => {
  assert.equal(
    shouldUseIsolatedRunsDir({ NODE_TEST_CONTEXT: '1' }, ['node', 'src/index.ts']),
    true,
  );
  assert.equal(
    shouldUseIsolatedRunsDir({}, [
      'node',
      './node_modules/.bin/tsx',
      'services/gateway/src/methods/eval.test.ts',
    ]),
    true,
  );
  assert.equal(
    shouldUseIsolatedRunsDir({}, [
      'node',
      './node_modules/.bin/tsx',
      'services/gateway/src/index.ts',
    ]),
    false,
  );
});

test('createRun assigns canonical family defaults for root runs', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}`,
  });
  t.after(() => cleanupRun(run.id));

  assert.equal(run.familyId, run.id);
  assert.equal(run.parentRunId, null);
  assert.equal(run.familyRootTicketOrPr, run.ticketOrPr);
});

test('createRun preserves explicit lineage for follow-up runs', async (t) => {
  const root = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-root`,
  });
  const followUp = createRun({
    flowType: 'pr-complete',
    project: root.project,
    ticketOrPr: 'example-org/example-mobile#123',
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
  });

  t.after(async () => {
    await cleanupRun(followUp.id);
    await cleanupRun(root.id);
  });

  assert.equal(followUp.familyId, root.familyId);
  assert.equal(followUp.parentRunId, root.id);
  assert.equal(followUp.familyRootTicketOrPr, root.ticketOrPr);
});

test('createRun persists input PR number for review runs', async (t) => {
  const run = createRun({
    flowType: 'review-pr',
    project: 'example-mobile-farm',
    ticketOrPr: 'example-org/example-mobile#29655',
  });
  t.after(() => cleanupRun(run.id));

  assert.equal(run.prNumber, 29655);
});

test('createRun honors explicit PR number for PR-bound follow-up runs', async (t) => {
  const run = createRun({
    flowType: 'pr-complete',
    project: 'example-mobile-farm',
    ticketOrPr: 'PROJ-29655',
    prNumber: 29655,
  });
  t.after(() => cleanupRun(run.id));

  assert.equal(run.prNumber, 29655);
});

test('createRun persists artifact-only completion policy on the run record', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    mode: 'validation',
    lane: 'validation',
    completionPolicy: 'artifact-only',
  });
  t.after(() => cleanupRun(run.id));

  assert.equal(run.completionPolicy, 'artifact-only');
});

test('createRun persists startRef provenance for artifact-only dev comparison runs and suppresses PR linkage', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `example-org/example-mobile#${Date.now()}`,
    familyId: `family-${Date.now()}`,
    lane: 'comparison',
    variant: 'candidate-start-ref',
    completionPolicy: 'artifact-only',
    startRef: 'main',
  });
  t.after(() => cleanupRun(run.id));

  assert.deepEqual(run.startRef, {
    requestedRef: 'main',
    source: { kind: 'manual' },
  });
  assert.equal(run.prNumber, undefined);
});

test('createRun rejects direct prior-run startRef provenance', async (t) => {
  const root = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-baseline`,
  });
  t.after(() => cleanupRun(root.id));

  assert.throws(
    () =>
      createRun({
        flowType: 'dev',
        project: root.project,
        ticketOrPr: root.ticketOrPr,
        familyId: root.familyId,
        parentRunId: root.id,
        lane: 'comparison',
        variant: 'candidate-start-ref',
        completionPolicy: 'artifact-only',
        startRef: 'main',
        startRefSource: { kind: 'prior-run', runId: root.id },
      } as any),
    /eval\.experiment\.create \+ eval\.trial\.start/,
  );
});

test('createRun rejects an explicit empty allowedSlots list', () => {
  assert.throws(
    () =>
      createRun({
        flowType: 'fix-bug',
        project: 'example-mobile-farm',
        ticketOrPr: `PROJ-${Date.now()}-empty-allowed`,
        allowedSlots: [],
      }),
    /active slot filters resolved to no matching slots/,
  );
});

test('normalizeRunClassification defaults production lane and no variant', () => {
  assert.deepEqual(normalizeRunClassification({ mode: 'interactive' }), {
    lane: 'production',
    variant: null,
  });
});

test('normalizeRunClassification derives validation lane from validation mode', () => {
  assert.deepEqual(normalizeRunClassification({ mode: 'validation' }), {
    lane: 'validation',
    variant: null,
  });
});

test('normalizeRunClassification requires variant for comparison lane', () => {
  assert.throws(
    () => normalizeRunClassification({ lane: 'comparison', mode: 'interactive' }),
    /Comparison lane requires a variant label/,
  );
});

test('normalizeRunClassification rejects variant outside comparison lane', () => {
  assert.throws(
    () => normalizeRunClassification({ lane: 'production', variant: 'codex', mode: 'interactive' }),
    /Variant is only allowed for comparison lane runs/,
  );
});

test('listRuns supports familyId/lane/variant filtering', async (t) => {
  const ids: string[] = [];
  const root = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-family`,
  });
  ids.push(root.id);
  const cmpA = createRun({
    flowType: 'review-pr',
    project: root.project,
    ticketOrPr: root.ticketOrPr,
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    lane: 'comparison',
    variant: 'claude',
  });
  ids.push(cmpA.id);
  updateRun(cmpA.id, { prNumber: 123 });
  const cmpB = createRun({
    flowType: 'review-pr',
    project: root.project,
    ticketOrPr: root.ticketOrPr,
    familyId: root.familyId,
    parentRunId: root.id,
    familyRootTicketOrPr: root.ticketOrPr,
    lane: 'comparison',
    variant: 'codex',
  });
  ids.push(cmpB.id);
  updateRun(cmpB.id, { prNumber: 123 });

  t.after(async () => {
    for (const id of ids.reverse()) await cleanupRun(id);
  });

  assert.equal(listRuns({ familyId: root.familyId, limit: 10 }).runs.length, 3);
  assert.equal(
    listRuns({ lane: 'comparison', limit: 10 }).runs.filter((r) => r.familyId === root.familyId)
      .length,
    2,
  );
  assert.equal(listRuns({ familyId: root.familyId, variant: 'claude', limit: 10 }).runs.length, 1);
  assert.equal(
    listRuns({ prNumber: 123, limit: 10 }).runs.filter((r) => r.familyId === root.familyId).length,
    2,
  );
});

test('createRun resolves safetyTier from runner default when caller omits it', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-tier-default`,
    runner: 'codex',
  });
  t.after(() => cleanupRun(run.id));

  // Runner explicit → tier pinned to registry default (sandboxed after ADR-023
  // refactor). Badge/UI sees concrete tier, not undefined.
  assert.equal(run.safetyTier, runnerDefaultSafetyTier('codex'));
});

test('createRun preserves explicit safetyTier passed by caller', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-tier-explicit`,
    runner: 'claude',
    safetyTier: 'sandboxed',
  });
  t.after(() => cleanupRun(run.id));

  assert.equal(run.safetyTier, 'sandboxed');
});

test('createRun leaves safetyTier undefined when neither tier nor runner is provided (deferred to FIND_SLOT)', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-tier-deferred`,
  });
  t.after(() => cleanupRun(run.id));

  // Runner is unknown at create time, so tier must not be pinned to Claude's
  // default — FIND_SLOT resolves the actual runner and promotes the tier then.
  assert.equal(run.safetyTier, undefined);
});

test('createRun pins safetyTier to runner default when runner is explicit but tier is not', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-tier-from-runner`,
    runner: 'codex',
  });
  t.after(() => cleanupRun(run.id));

  assert.equal(run.safetyTier, runnerDefaultSafetyTier('codex'));
});

test('createRun does not seed agent context with orchestrator-absolute taskFile', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-absolute-context`,
    runner: 'codex',
    slotId: 'runner-browser-1',
    taskFile: '/tmp/orchestrator/projects/example-browser-farm/tasks/fix/TASK.md',
  });
  t.after(() => cleanupRun(run.id));

  assert.equal(run.agentContexts?.[0]?.taskFile, null);
  assert.equal(run.agentContexts?.[0]?.signalFile, null);
});

test('listRuns uses higher default limit for family queries', async (t) => {
  const ids: string[] = [];
  const root = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-big-family`,
  });
  ids.push(root.id);
  for (let i = 0; i < 250; i++) {
    const run = createRun({
      flowType: 'review-pr',
      project: root.project,
      ticketOrPr: root.ticketOrPr,
      familyId: root.familyId,
      parentRunId: root.id,
      familyRootTicketOrPr: root.ticketOrPr,
      lane: 'comparison',
      variant: `candidate-${i}`,
    });
    ids.push(run.id);
  }

  t.after(async () => {
    for (const id of ids.reverse()) await cleanupRun(id);
  });

  assert.equal(listRuns({ familyId: root.familyId }).runs.length, 251);
});

test('isSyntheticLeak detects completed fixture runs without touching real run shapes', async (t) => {
  const synthetic = createRun({
    flowType: 'review-pr',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-synthetic`,
  });
  updateRun(synthetic.id, {
    status: 'done',
    completedAt: new Date(Date.parse(synthetic.createdAt) + 100).toISOString(),
  });

  const withEvidence = createRun({
    flowType: 'review-pr',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-real`,
    runner: 'codex',
    slotId: 'runner-mobile-1',
    taskFile: '/tmp/TASK.md',
  });
  updateRun(withEvidence.id, {
    status: 'done',
    completedAt: new Date(Date.parse(withEvidence.createdAt) + 100).toISOString(),
  });
  const emptySteps = {
    ...synthetic,
    id: 'empty-steps',
    steps: [],
  };

  t.after(async () => {
    await cleanupRun(withEvidence.id);
    await cleanupRun(synthetic.id);
  });

  assert.equal(isSyntheticLeak(synthetic), true);
  assert.equal(isSyntheticLeak(withEvidence), false);
  assert.equal(isSyntheticLeak(emptySteps), false);
});

test('cleanupRuns quarantines synthetic fixture leaks', async () => {
  const synthetic = createRun({
    flowType: 'review-pr',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-cleanup-synthetic`,
  });
  updateRun(synthetic.id, {
    status: 'done',
    completedAt: new Date(Date.parse(synthetic.createdAt) + 100).toISOString(),
  });

  const preview = await cleanupRuns(true);
  assert.equal(preview.syntheticRunsDeleted.includes(synthetic.id), true);

  const result = await cleanupRuns(false);
  assert.equal(result.syntheticRunsDeleted.includes(synthetic.id), true);
  assert.equal(
    listRuns({ limit: 500 }).runs.some((run) => run.id === synthetic.id),
    false,
  );
});

// ─── backfillLegacySafetyTier ───

test('backfillLegacySafetyTier: pre-epoch run with no tier → dangerous (preserves legacy posture)', () => {
  assert.equal(
    backfillLegacySafetyTier({ safetyTier: undefined, createdAt: '2026-04-15T00:00:00.000Z' }),
    'dangerous',
  );
});

test('backfillLegacySafetyTier: post-epoch run with no tier → null (transient in-flight state)', () => {
  assert.equal(
    backfillLegacySafetyTier({ safetyTier: undefined, createdAt: '2026-04-21T00:00:00.000Z' }),
    null,
  );
});

test('backfillLegacySafetyTier: any run with explicit tier → null (no override)', () => {
  assert.equal(
    backfillLegacySafetyTier({ safetyTier: 'sandboxed', createdAt: '2026-04-01T00:00:00.000Z' }),
    null,
  );
  assert.equal(
    backfillLegacySafetyTier({ safetyTier: 'full-auto', createdAt: '2026-04-30T00:00:00.000Z' }),
    null,
  );
});

test('backfillLegacySafetyTier: unparseable createdAt → null (skip defensively)', () => {
  assert.equal(backfillLegacySafetyTier({ safetyTier: undefined, createdAt: 'not-a-date' }), null);
});

test('createRun preserves selected worker template version', async (t) => {
  const run = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-template`,
    taskTemplate: { fileName: 'fix-bug-v2.md', variant: 'v2' },
  });
  t.after(() => cleanupRun(run.id));

  assert.deepEqual(run.taskTemplate, { fileName: 'fix-bug-v2.md', variant: 'v2' });
});
