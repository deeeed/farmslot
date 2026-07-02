import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { runnerDefaultSafetyTier } from '../runners/registry.js';

import {
  archiveRun,
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
import { isLeakedGatewayTestRun } from './test-run-leak.js';

const execFileAsync = promisify(execFile);

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

test('createRun records lifecycle startedAt for run detail telemetry', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-started-at`,
  });
  t.after(() => cleanupRun(run.id));

  assert.equal(run.startedAt, run.createdAt);
});

test('createRun persists the domain overlay and omits it when unset', async (t) => {
  const withDomain = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-domain`,
    domain: 'blue',
  });
  t.after(() => cleanupRun(withDomain.id));
  const withoutDomain = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-no-domain`,
  });
  t.after(() => cleanupRun(withoutDomain.id));

  assert.equal(withDomain.domain, 'blue');
  assert.equal('domain' in withoutDomain, false);
});

test('createRun rejects domain names outside the slug contract and drops blank ones', async (t) => {
  for (const hostile of ['../evil', 'a b', 'a|b', 'a"b', 'Blue', 'a/../b', 'blue\nEVIL']) {
    assert.throws(
      () =>
        createRun({
          flowType: 'fix-bug',
          project: 'example-mobile-farm',
          ticketOrPr: `PROJ-${Date.now()}-bad-domain`,
          domain: hostile,
        }),
      /Invalid domain/,
      `expected rejection for domain ${JSON.stringify(hostile)}`,
    );
  }

  const blank = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-blank-domain`,
    domain: '   ',
  });
  t.after(() => cleanupRun(blank.id));
  assert.equal('domain' in blank, false);
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

test('updateRun keeps primary agent context status aligned with blocked runs', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-browser-farm',
    ticketOrPr: `PROJ-${Date.now()}-blocked-context`,
    runner: 'codex',
    slotId: 'runner-browser-1',
  });
  t.after(() => cleanupRun(run.id));

  assert.equal(run.agentContexts?.[0]?.status, 'working');

  const blocked = updateRun(run.id, {
    status: 'blocked',
    completedAt: '2026-06-22T10:00:00.000Z',
    error: 'blocked for validation',
  });

  assert.equal(blocked.agentContexts?.[0]?.status, 'blocked');
  assert.equal(blocked.agentContexts?.[0]?.completedAt, '2026-06-22T10:00:00.000Z');

  const resumed = updateRun(run.id, { status: 'monitoring', completedAt: undefined });
  assert.equal(resumed.agentContexts?.[0]?.status, 'working');
  assert.equal(resumed.agentContexts?.[0]?.completedAt, undefined);

  const reblocked = updateRun(run.id, {
    status: 'blocked',
    completedAt: '2026-06-22T10:01:00.000Z',
  });
  reblocked.agentContexts![0].status = 'working';
  const repaired = updateRun(run.id, { status: 'blocked' });
  assert.equal(repaired.agentContexts?.[0]?.status, 'blocked');
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

test('archiveRun stamps archivedAt before moving terminal runs out of active timelines', async (t) => {
  const run = createRun({
    flowType: 'dev',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-archive`,
  });
  updateRun(run.id, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: 'superseded baseline',
  });

  const archivedPath = path.join(
    os.tmpdir(),
    `farmslot-test-runs-${process.pid}`,
    'archive',
    `${run.id}.json`,
  );
  t.after(() =>
    unlink(archivedPath).catch(() => {
      // Best-effort test cleanup; absence means archiveRun already failed loudly above.
    }),
  );

  assert.equal(await archiveRun(run.id), true);
  assert.equal(getRun(run.id), undefined);
  assert.equal(
    listRuns({ familyId: run.familyId }).runs.some((candidate) => candidate.id === run.id),
    false,
  );

  const archived = JSON.parse(await readFile(archivedPath, 'utf-8')) as { archivedAt?: string };
  assert.match(archived.archivedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
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

test('cleanupRuns quarantines gateway test fixture leaks', async () => {
  const leaked = createRun({
    flowType: 'fix-bug',
    project: 'farmslot-farm',
    ticketOrPr: `PUBLISH-DRIFT-${Date.now().toString(16).toUpperCase()}`,
    mode: 'autonomous',
    initialContext: 'Exercise current package drift approval',
  });
  updateRun(leaked.id, {
    status: 'failed',
    taskFile: '/tmp/farmslot-package-drift-abc123/task.md',
  });
  assert.equal(isLeakedGatewayTestRun(getRun(leaked.id)!), true);

  const preview = await cleanupRuns(true);
  assert.equal(preview.syntheticRunsDeleted.includes(leaked.id), true);

  const result = await cleanupRuns(false);
  assert.equal(result.syntheticRunsDeleted.includes(leaked.id), true);
  assert.equal(getRun(leaked.id), undefined);
});

test('loadAllRuns quarantines persisted gateway test fixture leaks', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'farmslot-run-leak-'));
  const runId = '5dd53883-bb8f-4f24-a20e-a20ab2856974';
  const leaked = {
    id: runId,
    familyId: runId,
    parentRunId: null,
    familyRootTicketOrPr: 'PUBLISH-DRIFT-19F18DBCB68',
    lane: 'production',
    variant: null,
    flowType: 'fix-bug',
    mode: 'autonomous',
    status: 'failed',
    project: 'farmslot-farm',
    ticketOrPr: 'PUBLISH-DRIFT-19F18DBCB68',
    slotId: 'macwork-ff-2',
    taskFile: '/var/folders/xx/farmslot-package-drift-AbCdEf/task.md',
    steps: [{ name: 'write-task', status: 'done', statusReason: 'missing task file' }],
    decisions: [],
    metrics: {},
    createdAt: '2026-06-30T14:08:05.000Z',
    updatedAt: '2026-06-30T14:25:00.000Z',
    completedAt: '2026-06-30T14:25:00.000Z',
  };
  await writeFile(path.join(tmp, `${runId}.json`), JSON.stringify(leaked));
  const gatewayRoot = path.resolve(import.meta.dirname, '../..');
  const script = `
    process.env.FARMSLOT_RUNS_DIR = ${JSON.stringify(tmp)};
    const { loadAllRuns, getRun } = await import('./src/runs/store.js');
    await loadAllRuns();
    if (getRun(${JSON.stringify(runId)})) process.exit(2);
    const { readdir } = await import('node:fs/promises');
    const quarantine = await readdir(${JSON.stringify(path.join(tmp, 'quarantine'))}, { withFileTypes: false }).catch(() => []);
    if (!quarantine.some((name) => name.includes(${JSON.stringify(runId)}))) process.exit(3);
  `;
  await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: gatewayRoot,
  });
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

test('listRuns supports normalized tag filtering and tag search', async (t) => {
  const demo = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-demo-tag`,
  });
  const other = createRun({
    flowType: 'fix-bug',
    project: 'example-mobile-farm',
    ticketOrPr: `PROJ-${Date.now()}-other-tag`,
  });
  t.after(async () => {
    await cleanupRun(demo.id);
    await cleanupRun(other.id);
  });

  updateRun(demo.id, { tags: ['demo', 'launch-review'] });
  updateRun(other.id, { tags: ['regression'] });

  assert.deepEqual(
    listRuns({ tags: ['Demo'] }).runs.map((run) => run.id),
    [demo.id],
  );
  assert.deepEqual(
    listRuns({ search: 'launch', limit: 10 })
      .runs.filter((run) => [demo.id, other.id].includes(run.id))
      .map((run) => run.id),
    [demo.id],
  );
});

test('loadAllRuns migrates legacy farmslot project to farmslot-farm', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'farmslot-run-migrate-'));
  const runId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const legacy = {
    id: runId,
    familyId: runId,
    parentRunId: null,
    familyRootTicketOrPr: 'TEST-1',
    lane: 'production',
    variant: null,
    flowType: 'dev',
    mode: 'interactive',
    status: 'done',
    project: 'farmslot',
    ticketOrPr: 'TEST-1',
    steps: [],
    decisions: [],
    metrics: {},
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    completedAt: '2026-06-01T00:00:00.000Z',
  };
  await writeFile(path.join(tmp, `${runId}.json`), JSON.stringify(legacy));
  const gatewayRoot = path.resolve(import.meta.dirname, '../..');
  const script = `
    process.env.FARMSLOT_RUNS_DIR = ${JSON.stringify(tmp)};
    const { loadAllRuns, getRun } = await import('./src/runs/store.js');
    await loadAllRuns();
    const run = getRun(${JSON.stringify(runId)});
    if (!run || run.project !== 'farmslot-farm') process.exit(2);
  `;
  await execFileAsync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: gatewayRoot,
  });
  const disk = JSON.parse(await readFile(path.join(tmp, `${runId}.json`), 'utf8'));
  assert.equal(disk.project, 'farmslot-farm');
});
