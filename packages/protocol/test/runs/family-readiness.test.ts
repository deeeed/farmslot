import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { type Run, RUN_SELF_LEARNING_MISSING_SIGNALS } from '../../src/contracts/index.js';
import {
  attachRunListSummaries,
  buildFamilySummary,
  buildRunFamilyReadinessSummaries,
  buildRunProjectAnalyticsSummaries,
} from '../../src/runs/family-readiness.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: overrides.id ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    mode: overrides.mode ?? 'interactive',
    status: overrides.status ?? 'done',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    app: overrides.app,
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    taskFile: overrides.taskFile ?? null,
    activeTaskFile: overrides.activeTaskFile,
    prNumber: overrides.prNumber,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: null,
      runner: null,
      runnerSessionId: null,
      runnerSessionPath: null,
      outcome: 'success',
    },
    createdAt: overrides.createdAt ?? '2026-05-04T10:00:00.000Z',
    updatedAt: overrides.updatedAt ?? overrides.createdAt ?? '2026-05-04T10:00:00.000Z',
    ticketData: overrides.ticketData,
    grade: overrides.grade,
    humanGrade: overrides.humanGrade,
    links: overrides.links,
    summary: overrides.summary,
    reviewTier: overrides.reviewTier,
    completedAt: overrides.completedAt,
    error: overrides.error,
    monitorState: overrides.monitorState,
  };
}

test('attachRunListSummaries preserves current shape when summary flags are omitted', () => {
  const base = { runs: [makeRun()], totalCount: 1 };
  const result = attachRunListSummaries(base, {});

  assert.equal(result, base);
  assert.equal(result.summaryMeta, undefined);
  assert.equal(result.familySummaries, undefined);
  assert.equal(result.projectAnalytics, undefined);
});

test('family readiness groups by family and computes counts, completion, and latest run', () => {
  const summaries = buildRunFamilyReadinessSummaries([
    makeRun({
      id: 'fam-a',
      familyId: 'fam-a',
      familyRootTicketOrPr: 'PROJ-1',
      project: 'mobile',
      createdAt: '2026-05-04T10:00:00.000Z',
      updatedAt: '2026-05-04T10:00:00.000Z',
    }),
    makeRun({
      id: 'a-review',
      familyId: 'fam-a',
      parentRunId: 'fam-a',
      status: 'monitoring',
      project: 'mobile',
      createdAt: '2026-05-04T12:00:00.000Z',
      updatedAt: '2026-05-04T12:00:00.000Z',
      metrics: { nudgeCount: 0, model: null, runner: null },
    }),
    makeRun({
      id: 'fam-b',
      familyId: 'fam-b',
      familyRootTicketOrPr: 'PROJ-2',
      project: 'extension',
      status: 'failed',
      metrics: { nudgeCount: 0, model: null, runner: null, outcome: 'failure' },
      createdAt: '2026-05-04T11:00:00.000Z',
      updatedAt: '2026-05-04T11:00:00.000Z',
    }),
  ]);

  assert.deepEqual(
    summaries.map((summary) => summary.familyId),
    ['fam-a', 'fam-b'],
  );
  const familyA = summaries[0];
  assert.equal(familyA.familyRootTicketOrPr, 'PROJ-1');
  assert.equal(familyA.project, 'mobile');
  assert.equal(familyA.latestRunId, 'a-review');
  assert.equal(familyA.runCount, 2);
  assert.equal(familyA.terminalRunCount, 1);
  assert.equal(familyA.activeRunCount, 1);
  assert.equal(familyA.failedRunCount, 0);
  assert.equal(familyA.completionPercent, 50);
  assert.equal(familyA.completionState, 'active');
});

test('eligibility blocks active runs, pending decisions, and missing successful runs', () => {
  const [summary] = buildRunFamilyReadinessSummaries([
    makeRun({
      id: 'run-active',
      status: 'monitoring',
      metrics: { nudgeCount: 0, model: null, runner: null },
      decisions: [
        {
          id: 'decision-1',
          type: 'plan_confirmation',
          title: 'Confirm',
          description: 'Confirm',
          actions: [],
          createdAt: '2026-05-04T12:00:00.000Z',
        },
      ],
    }),
    makeRun({
      id: 'run-failed',
      status: 'failed',
      metrics: { nudgeCount: 0, model: null, runner: null, outcome: 'failure' },
    }),
  ]);

  assert.equal(summary.eligibility.state, 'blocked');
  assert.deepEqual(summary.eligibility.reasons, [
    'active-runs',
    'pending-decisions',
    'no-successful-run',
  ]);
  assert.deepEqual(summary.eligibility.missingSignals, []);
});

test('metadata-only successful families are unknown with centralized missing signal reasons', () => {
  const [summary] = buildRunFamilyReadinessSummaries([
    makeRun({
      id: 'done-success',
      status: 'done',
      metrics: { nudgeCount: 0, model: null, runner: null, outcome: 'success' },
    }),
  ]);

  assert.equal(summary.eligibility.state, 'unknown');
  assert.deepEqual(summary.eligibility.reasons, []);
  assert.deepEqual(summary.eligibility.missingSignals, [...RUN_SELF_LEARNING_MISSING_SIGNALS]);
});

test('completed families with metadata evidence, learnings, recipe, and diff are eligible', () => {
  const [summary] = buildRunFamilyReadinessSummaries([
    makeRun({
      id: 'done-ready',
      status: 'done',
      metrics: { nudgeCount: 0, model: null, runner: null, outcome: 'success' },
      decisions: [
        {
          id: 'decision-ready',
          type: 'plan_confirmation',
          title: 'Ready',
          description: 'Ready gate',
          actions: [],
          createdAt: '2026-05-04T12:00:00.000Z',
          resolvedAt: '2026-05-04T12:10:00.000Z',
          payload: {
            kind: 'ready',
            prNumber: 123,
            repo: 'example-org/example-mobile',
            diffStat: { files: 2, additions: 10, deletions: 4 },
            workerReport: 'Done',
            branch: 'fix/proj-1',
            recipeJson: '{"nodes":[]}',
            artifactManifest: [{ path: 'screenshots/a.png', purpose: 'screenshot' }],
            workerLearnings: 'Use stable perps selectors.',
          },
        },
      ],
    }),
  ]);

  assert.equal(summary.eligibility.state, 'eligible');
  assert.deepEqual(summary.eligibility.reasons, []);
  assert.deepEqual(summary.eligibility.missingSignals, []);
});

test('eligibility ignores evidence carried by failed siblings — only successful runs feed signals', () => {
  // Mixed family: a failed sibling has every payload signal, the successful
  // run has none. Self-learning training material should come from the
  // successful run, not the failed one — so the family must NOT be marked
  // eligible just because a failed run carries a recipe.
  const summaries = buildRunFamilyReadinessSummaries([
    makeRun({
      id: 'failed-with-payload',
      familyId: 'fam-mixed',
      status: 'failed',
      metrics: { nudgeCount: 0, model: null, runner: null, outcome: 'failure' },
      decisions: [
        {
          id: 'decision-failed',
          type: 'plan_confirmation',
          title: 'Failed but rich',
          description: 'Carries payload despite failure',
          actions: [],
          createdAt: '2026-05-04T11:00:00.000Z',
          resolvedAt: '2026-05-04T11:10:00.000Z',
          payload: {
            kind: 'ready',
            prNumber: 999,
            repo: 'example-org/example-mobile',
            diffStat: { files: 2, additions: 5, deletions: 1 },
            workerReport: 'Failed run',
            branch: 'fix/failed',
            recipeJson: '{"nodes":[]}',
            artifactManifest: [{ path: 'screenshots/a.png', purpose: 'screenshot' }],
            workerLearnings: 'Lessons from failure.',
          },
        },
      ],
    }),
    makeRun({
      id: 'success-empty',
      familyId: 'fam-mixed',
      status: 'done',
      metrics: { nudgeCount: 0, model: null, runner: null, outcome: 'success' },
      decisions: [],
    }),
  ]);

  const summary = summaries.find((s) => s.familyId === 'fam-mixed');
  assert.ok(summary, 'family summary should exist');
  assert.equal(summary!.eligibility.state, 'unknown');
  // Successful sibling has no signals — every missing-* reason should appear.
  assert.deepEqual(
    [...summary!.eligibility.missingSignals].sort(),
    [...RUN_SELF_LEARNING_MISSING_SIGNALS].sort(),
  );
});

test('project analytics aggregate family readiness by project', () => {
  const families = buildRunFamilyReadinessSummaries([
    makeRun({
      id: 'mobile-1',
      familyId: 'mobile-1',
      project: 'mobile',
      status: 'done',
      createdAt: '2026-05-04T10:00:00.000Z',
      updatedAt: '2026-05-04T10:00:00.000Z',
    }),
    makeRun({
      id: 'mobile-2',
      familyId: 'mobile-2',
      project: 'mobile',
      status: 'monitoring',
      metrics: { nudgeCount: 0, model: null, runner: null },
      createdAt: '2026-05-04T12:00:00.000Z',
      updatedAt: '2026-05-04T12:00:00.000Z',
    }),
    makeRun({
      id: 'extension-1',
      familyId: 'extension-1',
      project: 'extension',
      status: 'failed',
      metrics: { nudgeCount: 0, model: null, runner: null, outcome: 'failure' },
      createdAt: '2026-05-04T11:00:00.000Z',
      updatedAt: '2026-05-04T11:00:00.000Z',
    }),
  ]);
  const projects = buildRunProjectAnalyticsSummaries(families);

  assert.deepEqual(
    projects.map((project) => project.project),
    ['mobile', 'extension'],
  );
  assert.equal(projects[0].familyCount, 2);
  assert.equal(projects[0].runCount, 2);
  assert.equal(projects[0].activeFamilyCount, 1);
  assert.equal(projects[0].completedFamilyCount, 1);
  assert.equal(projects[0].blockedFamilyCount, 1);
  assert.equal(projects[0].unknownFamilyCount, 1);
  assert.equal(projects[0].latestRunAt, '2026-05-04T12:00:00.000Z');
});

test('summary metadata documents returned-run truncation scope', () => {
  const runs = [makeRun({ id: 'run-1' }), makeRun({ id: 'run-2' })];
  const result = attachRunListSummaries(
    { runs, totalCount: 5 },
    { includeFamilySummaries: true, includeProjectAnalytics: true },
  );

  assert.deepEqual(result.summaryMeta, {
    scope: 'returned-runs',
    summaryRunCount: 2,
    totalCount: 5,
    isTruncated: true,
  });
  assert.equal(result.familySummaries?.length, 1);
  assert.equal(result.projectAnalytics?.length, 1);
});

test('buildFamilySummary returns root-only summary for a single-run family', () => {
  const root = makeRun({ id: 'root', summary: 'Fix flaky perps test' });
  assert.equal(buildFamilySummary(root, root, [root]), 'Fix flaky perps test');
});

test('buildFamilySummary collapses to single summary when root and latest match', () => {
  const root = makeRun({ id: 'root', summary: 'Fix flaky perps test' });
  const latest = makeRun({ id: 'latest', parentRunId: 'root', summary: 'Fix flaky perps test' });
  assert.equal(buildFamilySummary(root, latest, [root, latest]), 'Fix flaky perps test');
});

test('buildFamilySummary joins root and follow-up summaries when they differ', () => {
  const root = makeRun({ id: 'root', summary: 'Fix flaky perps test' });
  const latest = makeRun({
    id: 'latest',
    parentRunId: 'root',
    summary: 'Land review feedback on selectors',
  });
  assert.equal(
    buildFamilySummary(root, latest, [root, latest]),
    'Fix flaky perps test · latest follow-up: Land review feedback on selectors',
  );
});

test('buildFamilySummary falls back to latest run summary when no root run exists', () => {
  // Comparison-only family: every run has lane='comparison', no production root.
  const newest = makeRun({
    id: 'cmp-newest',
    parentRunId: null,
    summary: 'Cursor variant: fix copy regression',
  });
  const older = makeRun({
    id: 'cmp-older',
    parentRunId: null,
    summary: 'Codex variant: fix copy regression',
  });
  assert.equal(
    buildFamilySummary(null, newest, [newest, older]),
    'Cursor variant: fix copy regression',
  );
});

test('buildFamilySummary falls back to ticket identifiers when no run carries a summary', () => {
  const root = makeRun({ id: 'root', summary: undefined, familyRootTicketOrPr: 'PROJ-9999' });
  const latest = makeRun({
    id: 'latest',
    parentRunId: 'root',
    summary: undefined,
    familyRootTicketOrPr: 'PROJ-9999',
  });
  assert.equal(buildFamilySummary(root, latest, [root, latest]), 'PROJ-9999');
});

test('buildFamilySummary returns empty string for an empty runs array', () => {
  assert.equal(buildFamilySummary(null, null, []), '');
});

test('run.list summary helper stays metadata-only and does not import artifact snapshot builders', () => {
  const source = readFileSync(
    new URL('../../src/runs/family-readiness.ts', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes('buildFamilyObservabilitySnapshotFromRuns'), false);
  assert.equal(source.includes('family-observability'), false);
  assert.equal(/from ['"]node:fs/.test(source), false);
  assert.equal(/\b(readdir|readFile|stat)\b/.test(source), false);
});
