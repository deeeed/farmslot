import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProjectCICheckGroup, PRStatus, Run } from '@farmslot/protocol';

import {
  computePRRecommendation,
  derivePRFamilyContext,
  derivePRMergeState,
  isPassiveMergeWaitCandidate,
  matchBotComments,
  matchCheckGroups,
  shouldIncludePRInDashboard,
  summarizeAllChecks,
} from './pr.js';

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
    prNumber: overrides.prNumber ?? 42,
    steps: overrides.steps ?? [],
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics ?? {
      nudgeCount: 0,
      model: 'gpt-5.5',
      runner: 'codex',
      runnerSessionId: null,
      runnerSessionPath: null,
    },
    createdAt: overrides.createdAt ?? '2026-04-15T00:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-04-15T00:00:00.000Z',
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

function makePR(overrides: Partial<PRStatus> = {}): PRStatus {
  return {
    pr: overrides.pr ?? 42,
    title: overrides.title ?? 'Example PR',
    summary: overrides.summary ?? null,
    repo: overrides.repo ?? 'owner/repo',
    headRef: overrides.headRef ?? null,
    project: overrides.project ?? 'example-mobile-farm',
    slot: overrides.slot ?? null,
    session: overrides.session ?? null,
    checks: overrides.checks ?? [],
    checkSummary: overrides.checkSummary ?? {
      passed: 1,
      failed: 0,
      pending: 0,
      skipped: 0,
      total: 1,
    },
    allPassed: overrides.allPassed ?? true,
    anyFailed: overrides.anyFailed ?? false,
    failedNames: overrides.failedNames ?? [],
    botComments: overrides.botComments ?? [],
    actionableBotComments: overrides.actionableBotComments ?? [],
    prState: overrides.prState ?? 'OPEN',
    merged: overrides.merged ?? false,
    mergeable: overrides.mergeable ?? 'MERGEABLE',
    mergeConflict: overrides.mergeConflict ?? false,
    reviewDecision: overrides.reviewDecision ?? 'APPROVED',
    recommendation: overrides.recommendation ?? 'READY',
    ownedFamily: overrides.ownedFamily,
    familyId: overrides.familyId,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr,
    familyRunCount: overrides.familyRunCount,
    activeFamilyRunCount: overrides.activeFamilyRunCount,
    workflowState: overrides.workflowState,
    mergeState: overrides.mergeState,
    latestRunId: overrides.latestRunId,
  };
}

test('derivePRFamilyContext groups by family and counts active runs', () => {
  const context = derivePRFamilyContext(
    [
      makeRun({
        id: 'root',
        familyId: 'family-a',
        prNumber: 42,
        status: 'done',
        updatedAt: '2026-04-15T00:00:00.000Z',
      }),
      makeRun({
        id: 'followup',
        familyId: 'family-a',
        prNumber: 42,
        status: 'ci-watching',
        updatedAt: '2026-04-15T01:00:00.000Z',
      }),
      makeRun({ id: 'other', familyId: 'family-b', prNumber: 77 }),
    ],
    42,
    'example-mobile-farm',
  );

  assert.deepEqual(context, {
    familyId: 'family-a',
    familyRootTicketOrPr: 'PROJ-1',
    familyRunCount: 2,
    activeRunCount: 1,
    latestRunId: 'followup',
    latestPrNumber: 42,
    workflowState: 'active',
    ownedPrFamily: true,
  });
});

test('standalone external PR review families do not project as owned families', () => {
  const context = derivePRFamilyContext(
    [
      makeRun({
        id: 'review-root',
        familyId: 'family-pr',
        flowType: 'review-pr',
        ticketOrPr: 'owner/repo#42',
        familyRootTicketOrPr: 'owner/repo#42',
        project: 'example-mobile-farm',
        prNumber: 42,
        status: 'done',
      }),
    ],
    42,
    'example-mobile-farm',
  );

  assert(context);
  assert.equal(context.ownedPrFamily, false);
  assert.equal(
    computePRRecommendation({
      prState: 'MERGED',
      workerActive: false,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: true,
      familyContext: context.ownedPrFamily ? context : null,
    }),
    'MERGED',
  );
});

test('derivePRMergeState exposes passive waiting for merge for owned families', () => {
  const familyContext = derivePRFamilyContext(
    [
      makeRun({ id: 'root', familyId: 'family-a', prNumber: 42, status: 'done' }),
      makeRun({
        id: 'followup',
        familyId: 'family-a',
        prNumber: 42,
        status: 'done',
        updatedAt: '2026-04-15T01:00:00.000Z',
      }),
    ],
    42,
    'example-mobile-farm',
  )!;

  assert.equal(
    derivePRMergeState({
      prState: 'OPEN',
      familyContext,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: true,
    }),
    'waiting_for_merge',
  );
  assert.equal(
    derivePRMergeState({
      prState: 'MERGED',
      familyContext,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: true,
    }),
    'merged',
  );
  assert.equal(
    derivePRMergeState({
      prState: 'CLOSED',
      familyContext,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: true,
    }),
    'closed_without_merge',
  );
  assert.equal(
    derivePRMergeState({
      prState: 'OPEN',
      familyContext: null,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: true,
    }),
    'not_applicable',
  );
});

test('isPassiveMergeWaitCandidate requires workflow completion plus clean open PR state', () => {
  const familyContext = {
    familyId: 'family-a',
    familyRootTicketOrPr: 'PROJ-1',
    familyRunCount: 2,
    activeRunCount: 0,
    latestRunId: 'followup',
    latestPrNumber: 42,
    workflowState: 'complete' as const,
    ownedPrFamily: true,
  };

  assert.equal(
    isPassiveMergeWaitCandidate({
      prState: 'OPEN',
      familyContext,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: true,
    }),
    true,
  );
  assert.equal(
    isPassiveMergeWaitCandidate({
      prState: 'OPEN',
      familyContext,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: false,
      approved: true,
    }),
    false,
  );
  assert.equal(
    isPassiveMergeWaitCandidate({
      prState: 'OPEN',
      familyContext,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: false,
    }),
    false,
  );
  assert.equal(
    isPassiveMergeWaitCandidate({
      prState: 'OPEN',
      familyContext: { ...familyContext, workflowState: 'failed' as const },
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: true,
    }),
    false,
  );
});

test('computePRRecommendation distinguishes waiting, merged, and closed-without-merge', () => {
  const familyContext = {
    familyId: 'family-a',
    familyRootTicketOrPr: 'PROJ-1',
    familyRunCount: 2,
    activeRunCount: 0,
    latestRunId: 'followup',
    latestPrNumber: 42,
    workflowState: 'complete' as const,
    ownedPrFamily: true,
  };

  assert.equal(
    computePRRecommendation({
      prState: 'OPEN',
      workerActive: false,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: true,
      familyContext,
    }),
    'WAITING_FOR_MERGE',
  );

  assert.equal(
    computePRRecommendation({
      prState: 'MERGED',
      workerActive: false,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: true,
      familyContext,
    }),
    'MERGED',
  );

  assert.equal(
    computePRRecommendation({
      prState: 'CLOSED',
      workerActive: false,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: true,
      approved: true,
      familyContext,
    }),
    'CLOSED_WITHOUT_MERGE',
  );

  assert.equal(
    computePRRecommendation({
      prState: 'OPEN',
      workerActive: false,
      anyFailed: false,
      mergeConflict: false,
      actionableCount: 0,
      allPassed: false,
      approved: false,
      familyContext,
    }),
    'IN_REVIEW',
  );
});

test('shouldIncludePRInDashboard keeps owned merged/closed families visible', () => {
  assert.equal(shouldIncludePRInDashboard(makePR({ prState: 'OPEN' })), true);
  assert.equal(shouldIncludePRInDashboard(makePR({ prState: 'MERGED', ownedFamily: true })), true);
  assert.equal(shouldIncludePRInDashboard(makePR({ prState: 'CLOSED', ownedFamily: true })), true);
  assert.equal(
    shouldIncludePRInDashboard(makePR({ prState: 'MERGED', ownedFamily: false })),
    false,
  );
});

test('matchCheckGroups aggregates sharded checks deterministically', () => {
  const groups: ProjectCICheckGroup[] = [
    { name: 'Test lint', match: 'Test lint', matchMode: 'exact', aggregate: 'all' },
    {
      name: 'Unit tests',
      match: '^Run tests / Unit tests \\(\\d+\\)$',
      matchMode: 'regex',
      aggregate: 'all',
    },
    {
      name: 'CI status gate',
      match: 'ci-status-gate / CI status gate (controls all-jobs-pass)',
      matchMode: 'exact',
      aggregate: 'all',
    },
  ];

  const matched = matchCheckGroups(
    [
      {
        name: 'Test lint',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-24T09:40:12Z',
        index: 0,
      },
      {
        name: 'Run tests / Unit tests (1)',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-24T09:34:24Z',
        index: 1,
      },
      {
        name: 'Run tests / Unit tests (2)',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-24T09:34:17Z',
        index: 2,
      },
      {
        name: 'ci-status-gate / CI status gate (controls all-jobs-pass)',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-24T09:51:17Z',
        index: 3,
      },
    ],
    groups,
  );

  assert.deepEqual(matched, [
    { name: 'Test lint', status: 'pass', watchName: 'Test lint' },
    { name: 'Unit tests', status: 'pass', watchName: 'Unit tests' },
    {
      name: 'ci-status-gate / CI status gate (controls all-jobs-pass)',
      status: 'pass',
      watchName: 'CI status gate',
    },
  ]);
});

test('matchCheckGroups normalizes raw statuses when no groups are configured', () => {
  const matched = matchCheckGroups(
    [
      { name: 'Repo guards', status: 'pass', startedAt: '', completedAt: '', index: 0 },
      { name: 'CLI quality', status: 'skipping', startedAt: '', completedAt: '', index: 1 },
      { name: 'Docs quality', status: 'skipped', startedAt: '', completedAt: '', index: 2 },
      { name: 'Gateway quality', status: 'in_progress', startedAt: '', completedAt: '', index: 3 },
    ],
    [],
  );

  assert.deepEqual(
    matched.map((m) => m.status),
    ['pass', 'skipped', 'skipped', 'pending'],
  );
});

test('matchCheckGroups treats skipped shards as neutral in aggregates', () => {
  const mk = (name: string, status: string, index: number) => ({
    name,
    status,
    startedAt: '',
    completedAt: '',
    index,
  });
  const group = (aggregate: 'all' | 'any' | 'latest'): ProjectCICheckGroup[] => [
    { name: 'Suite', match: 'Suite', matchMode: 'includes', aggregate },
  ];

  // all: skipped shards do not hold the group pending or block a pass
  assert.equal(
    matchCheckGroups([mk('Suite (1)', 'pass', 0), mk('Suite (2)', 'skipping', 1)], group('all'))[0]
      .status,
    'pass',
  );
  // all: a group whose every shard skipped reports skipped, not pending
  assert.equal(
    matchCheckGroups(
      [mk('Suite (1)', 'skipping', 0), mk('Suite (2)', 'skipped', 1)],
      group('all'),
    )[0].status,
    'skipped',
  );
  // any: a failing shard still fails when the rest skipped
  assert.equal(
    matchCheckGroups([mk('Suite (1)', 'fail', 0), mk('Suite (2)', 'skipping', 1)], group('any'))[0]
      .status,
    'fail',
  );
  // latest: a skipped latest shard reports skipped
  assert.equal(
    matchCheckGroups([mk('Suite (1)', 'skipping', 0)], group('latest'))[0].status,
    'skipped',
  );
});

test('matchCheckGroups uses latest aggregate for legacy contains-style groups', () => {
  const groups: ProjectCICheckGroup[] = [
    { name: 'Unit tests', match: 'Unit tests', matchMode: 'includes', aggregate: 'latest' },
  ];

  const matched = matchCheckGroups(
    [
      {
        name: 'Run tests / Unit tests (1)',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-24T09:34:24Z',
        index: 0,
      },
      {
        name: 'Run tests / Unit tests (2)',
        status: 'pending',
        startedAt: '2026-04-24T09:35:00Z',
        completedAt: '',
        index: 1,
      },
    ],
    groups,
  );

  assert.deepEqual(matched, [
    { name: 'Run tests / Unit tests (2)', status: 'pending', watchName: 'Unit tests' },
  ]);
});

test('matchCheckGroups matches mobile ci-watch groups against current naming', () => {
  const groups: ProjectCICheckGroup[] = [
    { name: 'Run `lint`', match: 'Run `lint`', matchMode: 'exact', aggregate: 'all' },
    { name: 'Run `lint:tsc`', match: 'Run `lint:tsc`', matchMode: 'exact', aggregate: 'all' },
    {
      name: 'Run `format:check`',
      match: 'Run `format:check`',
      matchMode: 'exact',
      aggregate: 'all',
    },
    {
      name: 'Unit tests',
      match: '^Unit tests(?: \\(\\d+\\))?$',
      matchMode: 'regex',
      aggregate: 'all',
    },
    {
      name: 'SonarCloud quality gate',
      match: '^SonarCloud quality gate(?: status)?$',
      matchMode: 'regex',
      aggregate: 'all',
    },
    {
      name: 'All jobs pass',
      match: '^(?:All jobs pass|Check all jobs pass)$',
      matchMode: 'regex',
      aggregate: 'latest',
    },
  ];

  const matched = matchCheckGroups(
    [
      {
        name: 'Run `lint`',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-25T00:12:40Z',
        index: 0,
      },
      {
        name: 'Run `lint:tsc`',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-25T00:07:25Z',
        index: 1,
      },
      {
        name: 'Run `format:check`',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-25T00:05:39Z',
        index: 2,
      },
      {
        name: 'Unit tests (1)',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-25T00:12:00Z',
        index: 3,
      },
      {
        name: 'Unit tests (10)',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-25T00:13:57Z',
        index: 4,
      },
      {
        name: 'SonarCloud quality gate status',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-25T00:22:21Z',
        index: 5,
      },
      {
        name: 'All jobs pass',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-25T00:22:27Z',
        index: 6,
      },
      {
        name: 'Check all jobs pass',
        status: 'pass',
        startedAt: '',
        completedAt: '2026-04-25T00:30:19Z',
        index: 7,
      },
    ],
    groups,
  );

  assert.deepEqual(matched, [
    { name: 'Run `lint`', status: 'pass', watchName: 'Run `lint`' },
    { name: 'Run `lint:tsc`', status: 'pass', watchName: 'Run `lint:tsc`' },
    { name: 'Run `format:check`', status: 'pass', watchName: 'Run `format:check`' },
    { name: 'Unit tests', status: 'pass', watchName: 'Unit tests' },
    {
      name: 'SonarCloud quality gate status',
      status: 'pass',
      watchName: 'SonarCloud quality gate',
    },
    { name: 'Check all jobs pass', status: 'pass', watchName: 'All jobs pass' },
  ]);
});

test('summarizeAllChecks tracks full GitHub rollup separately from watched groups', () => {
  const summary = summarizeAllChecks([
    { name: 'All jobs pass', status: 'pass', startedAt: '', completedAt: '', index: 0 },
    {
      name: 'iOS E2E Smoke Tests / wallet-platform-ios-smoke',
      status: 'pending',
      startedAt: '',
      completedAt: '',
      index: 1,
    },
    {
      name: 'Android E2E Smoke Tests / accounts-android-smoke',
      status: 'skipping',
      startedAt: '',
      completedAt: '',
      index: 2,
    },
    { name: 'check-pr-labels', status: 'fail', startedAt: '', completedAt: '', index: 3 },
    { name: 'cancelled-check', status: 'cancelled', startedAt: '', completedAt: '', index: 4 },
  ]);

  assert.deepEqual(summary.summary, { passed: 1, failed: 2, pending: 1, skipped: 1, total: 5 });
  assert.deepEqual(summary.pendingNames, ['iOS E2E Smoke Tests / wallet-platform-ios-smoke']);
  assert.deepEqual(summary.failedNames, ['check-pr-labels', 'cancelled-check']);
});

test('matchBotComments classifies cursor bugbot findings as actionable for extension/mobile-style config', () => {
  const botComments = matchBotComments(
    [],
    [
      {
        id: 1,
        author: 'cursor[bot]',
        body: '### Path validation fails for base /perps with query strings\n\n**Low Severity**',
        created_at: '2026-04-25T02:56:29Z',
        in_reply_to_id: null,
      },
    ],
    [
      {
        author: 'cursor\\[bot\\]',
        label: 'cursor-bugbot',
        defaultAction: 'nudge_worker',
      },
    ],
    new Set<number>(),
    null,
  );

  assert.deepEqual(botComments, [
    {
      author: 'cursor[bot]',
      label: 'cursor-bugbot',
      action: 'nudge_worker',
      bodyPreview:
        '### Path validation fails for base /perps with query strings\n\n**Low Severity**',
      bodyFingerprint: '1e4db69999f48dc72d6e623614ceb413c458b1d829687ac02b78cbec0a914a26',
      createdAt: '2026-04-25T02:56:29Z',
      source: 'review_comment',
      workerResponded: false,
    },
  ]);
});

test('matchBotComments keeps review comments actionable until replied in-thread even after newer commits', () => {
  const botComments = matchBotComments(
    [],
    [
      {
        id: 7,
        author: 'cursor[bot]',
        body: '### Path validation fails for base /perps with query strings',
        created_at: '2026-04-25T02:56:29Z',
        in_reply_to_id: null,
      },
    ],
    [
      {
        author: 'cursor\\[bot\\]',
        label: 'cursor-bugbot',
        defaultAction: 'nudge_worker',
      },
    ],
    new Set<number>(),
    '2026-04-25T03:18:20Z',
  );

  assert.equal(botComments.length, 1);
  assert.equal(botComments[0].workerResponded, false);
  assert.equal(botComments[0].action, 'nudge_worker');
});

test('matchBotComments marks review comments handled once replied in-thread', () => {
  const botComments = matchBotComments(
    [],
    [
      {
        id: 7,
        author: 'cursor[bot]',
        body: '### Path validation fails for base /perps with query strings',
        created_at: '2026-04-25T02:56:29Z',
        in_reply_to_id: null,
      },
    ],
    [
      {
        author: 'cursor\\[bot\\]',
        label: 'cursor-bugbot',
        defaultAction: 'nudge_worker',
      },
    ],
    new Set<number>([7]),
    '2026-04-25T03:18:20Z',
  );

  assert.equal(botComments.length, 1);
  assert.equal(botComments[0].workerResponded, true);
});
