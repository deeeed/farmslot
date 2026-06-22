import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FamilyChangeLedgerEntry,
  Run,
  RunFamilyReadinessSummary,
  RunProjectAnalyticsSummary,
} from '@farmslot/protocol';

import { colors } from '../../styles/theme-tokens.js';

import {
  canCompareRuns,
  collectRunEvidenceArtifacts,
  eligibilityColor,
  eligibilityLabel,
  familyCompletionColor,
  familyCompletionLabel,
  familyLedgerTurnLabel,
  formatCompletionPercent,
  groupRunsByFamily,
  isCIWatchWorkerFixActive,
  isEvalCandidateRun,
  isSameFamilyComparisonPair,
  pickComparisonPartner,
  pickFamilyComparePair,
  prLinkForRun,
  routeForRun,
  runDisplayLabel,
  runDisplayTitle,
  runStatusColor,
  sortProjectAnalyticsForDisplay,
  sortRunsForFamilyView,
  summarizeEligibilityReasons,
} from './run-utils.js';

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
    status: overrides.status ?? 'monitoring',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    app: overrides.app,
    slotId: overrides.slotId ?? null,
    branch: overrides.branch ?? null,
    completionPolicy: overrides.completionPolicy,
    startRef: overrides.startRef,
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
    engineState: overrides.engineState,
  };
}

test('routeForRun always opens run detail, including terminal family runs', () => {
  assert.equal(routeForRun(makeRun({ id: 'active-run', status: 'monitoring' })), 'run/active-run');
  assert.equal(routeForRun(makeRun({ id: 'done-run', status: 'done' })), 'run/done-run');
  assert.equal(routeForRun(makeRun({ id: 'failed-run', status: 'failed' })), 'run/failed-run');
});

function makeLedgerEntry(
  overrides: Partial<FamilyChangeLedgerEntry> = {},
): FamilyChangeLedgerEntry {
  return {
    runId: overrides.runId ?? 'run-1',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'fix-bug',
    project: overrides.project ?? 'example-mobile-farm',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    branch: overrides.branch ?? null,
    prNumber: overrides.prNumber ?? null,
    createdAt: overrides.createdAt ?? '2026-04-15T00:00:00.000Z',
    changeKind: overrides.changeKind ?? 'none',
    contributionDiff: overrides.contributionDiff ?? {
      source: 'unavailable',
      available: false,
      files: 0,
      additions: 0,
      deletions: 0,
      kind: 'contribution',
    },
    inputDiff: overrides.inputDiff,
    legacyDiffFallback: overrides.legacyDiffFallback,
    inputCommit: overrides.inputCommit,
    reviewSignals: overrides.reviewSignals,
    artifactFootprint: overrides.artifactFootprint ?? {
      count: 0,
      bytes: 0,
      byPurpose: [],
      bySource: [],
      byExtension: [],
    },
    taskInputArtifacts: overrides.taskInputArtifacts ?? [],
    missingData: overrides.missingData ?? [],
  };
}

test('canCompareRuns requires same family', () => {
  assert.equal(
    canCompareRuns(makeRun({ familyId: 'fam-a' }), makeRun({ familyId: 'fam-a' })),
    true,
  );
  assert.equal(
    canCompareRuns(makeRun({ familyId: 'fam-a' }), makeRun({ familyId: 'fam-b' })),
    false,
  );
});

test('runStatusColor differentiates cancelled runs from failed runs', () => {
  assert.equal(runStatusColor('failed'), colors.statusFail);
  assert.equal(runStatusColor('cancelled'), colors.statusWarn);
});

test('collectRunEvidenceArtifacts normalizes complete-step artifacts for replay evidence', () => {
  const artifacts = collectRunEvidenceArtifacts(
    makeRun({
      id: 'run-replay',
      familyId: 'family-replay',
      steps: [
        {
          name: 'complete',
          status: 'done',
          outputs: {
            artifacts: [
              { path: 'artifacts/report.md', purpose: 'report', sizeBytes: 123 },
              { path: 'artifacts/after.mp4', sizeBytes: 456 },
              { path: 'artifacts/after.mp4', sizeBytes: 456 },
              { path: '' },
              { noPath: true },
            ],
          },
        },
      ],
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact) => ({
      runId: artifact.runId,
      familyId: artifact.familyId,
      stepName: artifact.stepName,
      path: artifact.path,
      purpose: artifact.purpose,
      source: artifact.source,
      sizeBytes: artifact.sizeBytes,
    })),
    [
      {
        runId: 'run-replay',
        familyId: 'family-replay',
        stepName: 'complete',
        path: 'artifacts/report.md',
        purpose: 'report',
        source: 'step-output',
        sizeBytes: 123,
      },
      {
        runId: 'run-replay',
        familyId: 'family-replay',
        stepName: 'complete',
        path: 'artifacts/after.mp4',
        purpose: 'video-after',
        source: 'step-output',
        sizeBytes: 456,
      },
    ],
  );
});



test('collectRunEvidenceArtifacts prefers curated package evidence and drops runtime internals', () => {
  const artifacts = collectRunEvidenceArtifacts(
    makeRun({
      id: 'run-package',
      familyId: 'family-package',
      decisions: [
        {
          id: 'gate-1',
          type: 'engine_human_gate',
          title: 'Ready',
          description: 'Ready',
          createdAt: '2026-04-15T00:00:00.000Z',
          actions: [],
          payload: {
            kind: 'ready',
            prPackage: {
              evidenceManifest: [
                { path: 'artifacts/recipe-run/after.png', purpose: 'screenshot', sizeBytes: 456 },
              ],
            },
          } as unknown as Run['decisions'][number]['payload'],
        },
      ],
      steps: [
        {
          name: 'complete',
          status: 'done',
          outputs: {
            artifacts: [
              { path: 'artifacts/report.md', purpose: 'report', sizeBytes: 123 },
              { path: 'artifacts/recipe-run/after.png', purpose: 'screenshot', sizeBytes: 456 },
              { path: 'artifacts/recipe-run/debug.png', purpose: 'screenshot', sizeBytes: 789 },
              { path: 'artifacts/runtime-launch/chrome-profile/Local State', purpose: 'other' },
              { path: 'artifacts/runner-blockers/self-review-launch.txt', purpose: 'other' },
            ],
          },
        },
      ],
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact) => ({
      path: artifact.path,
      purpose: artifact.purpose,
      stepName: artifact.stepName,
      source: artifact.source,
    })),
    [
      {
        path: 'artifacts/recipe-run/after.png',
        purpose: 'screenshot',
        stepName: 'publish-gate',
        source: 'task-artifact',
      },
      {
        path: 'artifacts/report.md',
        purpose: 'report',
        stepName: 'complete',
        source: 'step-output',
      },
    ],
  );
});


test('eval candidate runs display as eval without adding a flow type', () => {
  const evalRun = makeRun({
    flowType: 'dev',
    lane: 'comparison',
    ticketOrPr: 'EVAL-1234',
    completionPolicy: 'artifact-only',
    engineState: {
      evalExperiment: {
        experimentId: 'experiment-1',
        experimentKey: 'key-1',
        experimentManifestPath: '/tmp/experiment.json',
        packagePath: '/tmp/candidate.json',
        candidateStrategyFingerprint: 'fingerprint',
        trialId: 'trial-1',
      },
    },
  });
  assert.equal(isEvalCandidateRun(evalRun), true);
  assert.equal(runDisplayLabel(evalRun), 'EVAL');
  assert.match(runDisplayTitle(evalRun), /dev carrier/);
  assert.equal(
    runDisplayLabel(makeRun({ flowType: 'dev', lane: 'production', ticketOrPr: 'PROJ-1' })),
    'DEV',
  );
});

test('isCIWatchWorkerFixActive only trusts explicit ci-watch phase state', () => {
  assert.equal(isCIWatchWorkerFixActive('fixing', true), true);
  assert.equal(isCIWatchWorkerFixActive('waiting_for_worker', true), true);
  assert.equal(isCIWatchWorkerFixActive('polling', true), false);
  assert.equal(isCIWatchWorkerFixActive('fixing', false), false);
  assert.equal(isCIWatchWorkerFixActive(undefined, true), false);
});

test('prLinkForRun derives the PR when run links are missing', () => {
  assert.deepEqual(
    prLinkForRun(
      makeRun({
        flowType: 'review-pr',
        ticketOrPr: 'example-org/example-mobile#29655',
        links: undefined,
      }),
    ),
    {
      label: 'PR',
      url: 'https://github.com/example-org/example-mobile/pull/29655',
      ref: 'example-org/example-mobile#29655',
    },
  );
});

test('prLinkForRun only derives review-pr links', () => {
  assert.equal(
    prLinkForRun(
      makeRun({
        flowType: 'fix-bug',
        ticketOrPr: 'PROJ-1234',
        links: [{ label: 'PR', url: 'https://github.com/example-org/example-mobile/pull/29655' }],
      }),
    ),
    null,
  );
});

test('familyLedgerTurnLabel describes operator turns from ledger provenance', () => {
  assert.equal(
    familyLedgerTurnLabel(
      makeLedgerEntry({
        contributionDiff: {
          source: 'artifact',
          available: true,
          files: 1,
          additions: 2,
          deletions: 0,
          kind: 'contribution',
          artifactPath: 'artifacts/diff-stat.json',
        },
      }),
    ),
    'Produced code delta',
  );
  assert.equal(
    familyLedgerTurnLabel(
      makeLedgerEntry({
        flowType: 'review-pr',
        inputDiff: {
          source: 'artifact',
          available: true,
          files: 1,
          additions: 3,
          deletions: 1,
          kind: 'review-input',
          artifactPath: 'inputs/diff-stat.json',
        },
      }),
    ),
    'Reviewed PR input',
  );
  assert.equal(
    familyLedgerTurnLabel(
      makeLedgerEntry({
        flowType: 'review-pr',
        inputDiff: {
          source: 'unavailable',
          available: false,
          files: 0,
          additions: 0,
          deletions: 0,
          kind: 'review-input',
          missingReason: 'capture-failed',
        },
      }),
    ),
    'Missing reviewed input',
  );
  assert.equal(
    familyLedgerTurnLabel(
      makeLedgerEntry({
        flowType: 'pr-complete',
        contributionDiff: {
          source: 'artifact',
          available: true,
          files: 1,
          additions: 1,
          deletions: 1,
          kind: 'contribution',
          artifactPath: 'artifacts/diff-stat.json',
        },
      }),
    ),
    'Follow-up code delta',
  );
  assert.equal(familyLedgerTurnLabel(makeLedgerEntry({ changeKind: 'legacy' })), 'Legacy diff');
});

test('sortRunsForFamilyView keeps the family root first and variants stable', () => {
  const sorted = sortRunsForFamilyView([
    makeRun({
      id: 'run-codex',
      familyId: 'family-1',
      parentRunId: 'root-run',
      lane: 'comparison',
      variant: 'codex',
      createdAt: '2026-04-15T10:00:00.000Z',
    }),
    makeRun({
      id: 'run-claude',
      familyId: 'family-1',
      parentRunId: 'root-run',
      lane: 'comparison',
      variant: 'claude',
      createdAt: '2026-04-15T11:00:00.000Z',
    }),
    makeRun({
      id: 'family-1',
      familyId: 'family-1',
      parentRunId: null,
      ticketOrPr: 'PROJ-1',
      createdAt: '2026-04-15T09:00:00.000Z',
    }),
  ]);
  assert.deepEqual(
    sorted.map((run) => run.id),
    ['family-1', 'run-claude', 'run-codex'],
  );
});

test('groupRunsByFamily groups siblings and orders families by newest activity', () => {
  const groups = groupRunsByFamily([
    makeRun({
      id: 'family-a',
      familyId: 'family-a',
      createdAt: '2026-04-15T08:00:00.000Z',
      ticketOrPr: 'PROJ-1',
      familyRootTicketOrPr: 'PROJ-1',
    }),
    makeRun({
      id: 'a-claude',
      familyId: 'family-a',
      parentRunId: 'family-a',
      lane: 'comparison',
      variant: 'claude',
      createdAt: '2026-04-15T12:00:00.000Z',
      status: 'done',
    }),
    makeRun({
      id: 'a-codex',
      familyId: 'family-a',
      parentRunId: 'family-a',
      lane: 'comparison',
      variant: 'codex',
      createdAt: '2026-04-15T11:00:00.000Z',
      status: 'monitoring',
    }),
    makeRun({
      id: 'family-b',
      familyId: 'family-b',
      createdAt: '2026-04-15T09:00:00.000Z',
      ticketOrPr: 'PROJ-2',
      familyRootTicketOrPr: 'PROJ-2',
      status: 'failed',
    }),
  ]);

  assert.deepEqual(
    groups.map((group) => group.familyId),
    ['family-a', 'family-b'],
  );
  assert.equal(groups[0].familyRootTicketOrPr, 'PROJ-1');
  assert.equal(groups[0].rootRun?.id, 'family-a');
  assert.equal(groups[0].activeCount, 2);
  assert.equal(groups[0].comparisonCount, 2);
  assert.deepEqual(groups[0].variants, ['claude', 'codex']);
  assert.deepEqual(
    groups[0].runs.map((run) => run.id),
    ['family-a', 'a-claude', 'a-codex'],
  );
});

test('groupRunsByFamily picks the family root as representativeRun when one exists', () => {
  const [group] = groupRunsByFamily([
    makeRun({
      id: 'fam-root',
      familyId: 'fam-root',
      summary: 'Root summary',
      createdAt: '2026-04-15T08:00:00.000Z',
    }),
    makeRun({
      id: 'cmp-1',
      familyId: 'fam-root',
      parentRunId: 'fam-root',
      lane: 'comparison',
      variant: 'claude',
      summary: 'Variant claude',
      createdAt: '2026-04-15T12:00:00.000Z',
    }),
  ]);
  assert.equal(group.representativeRun.id, 'fam-root');
  assert.equal(group.familySummary, 'Root summary · latest follow-up: Variant claude');
});

test('groupRunsByFamily falls back to the newest run as representativeRun when no root exists', () => {
  const [group] = groupRunsByFamily([
    makeRun({
      id: 'cmp-newest',
      familyId: 'fam-cmp',
      parentRunId: 'missing-root',
      lane: 'comparison',
      variant: 'claude',
      summary: 'Cursor variant fix',
      createdAt: '2026-04-15T12:00:00.000Z',
    }),
    makeRun({
      id: 'cmp-older',
      familyId: 'fam-cmp',
      parentRunId: 'missing-root',
      lane: 'comparison',
      variant: 'codex',
      summary: 'Codex variant fix',
      createdAt: '2026-04-15T10:00:00.000Z',
    }),
  ]);
  assert.equal(group.rootRun, null);
  assert.equal(group.representativeRun.id, 'cmp-newest');
  assert.equal(group.familySummary, 'Cursor variant fix');
});

test('pickFamilyComparePair prefers the newest comparison runs with distinct variants', () => {
  const pair = pickFamilyComparePair([
    makeRun({
      id: 'family-a',
      familyId: 'family-a',
      lane: 'production',
      createdAt: '2026-04-15T08:00:00.000Z',
    }),
    makeRun({
      id: 'cmp-1',
      familyId: 'family-a',
      parentRunId: 'family-a',
      lane: 'comparison',
      variant: 'claude',
      createdAt: '2026-04-15T11:00:00.000Z',
    }),
    makeRun({
      id: 'cmp-2',
      familyId: 'family-a',
      parentRunId: 'family-a',
      lane: 'comparison',
      variant: 'claude',
      createdAt: '2026-04-15T12:00:00.000Z',
    }),
    makeRun({
      id: 'cmp-3',
      familyId: 'family-a',
      parentRunId: 'family-a',
      lane: 'comparison',
      variant: 'codex',
      createdAt: '2026-04-15T10:00:00.000Z',
    }),
  ]);
  assert.deepEqual(
    pair?.map((run) => run.id),
    ['cmp-2', 'cmp-3'],
  );
});

test('pickComparisonPartner returns the preferred sibling for a comparison run', () => {
  const current = makeRun({
    id: 'cmp-2',
    familyId: 'family-a',
    parentRunId: 'family-a',
    lane: 'comparison',
    variant: 'claude',
    createdAt: '2026-04-15T12:00:00.000Z',
  });
  const partner = pickComparisonPartner(current, [
    makeRun({
      id: 'cmp-1',
      familyId: 'family-a',
      parentRunId: 'family-a',
      lane: 'comparison',
      variant: 'claude',
      createdAt: '2026-04-15T11:00:00.000Z',
    }),
    makeRun({
      id: 'cmp-3',
      familyId: 'family-a',
      parentRunId: 'family-a',
      lane: 'comparison',
      variant: 'codex',
      createdAt: '2026-04-15T10:00:00.000Z',
    }),
  ]);
  assert.equal(partner?.id, 'cmp-3');
  assert.equal(pickComparisonPartner(makeRun({ lane: 'production' }), [current]), null);
});

test('isSameFamilyComparisonPair only accepts comparison candidates within the same family', () => {
  const baseline = makeRun({ id: 'baseline-run', familyId: 'family-a', lane: 'production' });
  const replay = makeRun({
    id: 'replay-run',
    familyId: 'family-a',
    lane: 'comparison',
    parentRunId: baseline.id,
  });
  assert.equal(isSameFamilyComparisonPair(baseline, replay), false);
  assert.equal(
    isSameFamilyComparisonPair(
      makeRun({ id: 'cmp-a', familyId: 'family-a', lane: 'comparison', variant: 'a' }),
      makeRun({ id: 'cmp-b', familyId: 'family-a', lane: 'comparison', variant: 'b' }),
    ),
    true,
  );
  assert.equal(
    isSameFamilyComparisonPair(
      makeRun({ id: 'cmp-a', familyId: 'family-a', lane: 'comparison', variant: 'a' }),
      makeRun({ id: 'cmp-b', familyId: 'family-b', lane: 'comparison', variant: 'b' }),
    ),
    false,
  );
});

test('readiness helpers format completion and eligibility badges', () => {
  assert.equal(formatCompletionPercent(49.5), '50%');
  assert.equal(formatCompletionPercent(150), '100%');
  assert.equal(formatCompletionPercent(Number.NaN), '0%');
  assert.equal(
    familyCompletionLabel({ completionState: 'active', completionPercent: 50 }),
    'active 50%',
  );
  assert.notEqual(familyCompletionColor('complete'), familyCompletionColor('failed'));
  assert.equal(eligibilityLabel('eligible'), 'learning eligible');
  assert.equal(eligibilityLabel('blocked'), 'learning blocked');
  assert.equal(eligibilityLabel('unknown'), 'learning unknown');
  assert.notEqual(eligibilityColor('blocked'), eligibilityColor('unknown'));
});

test('summarizeEligibilityReasons combines concrete blockers and missing signals', () => {
  const summary: RunFamilyReadinessSummary = {
    familyId: 'family-1',
    familyRootTicketOrPr: 'PROJ-1',
    project: 'mobile',
    latestRunId: 'run-1',
    latestRunAt: '2026-05-04T10:00:00.000Z',
    runCount: 1,
    terminalRunCount: 1,
    activeRunCount: 0,
    failedRunCount: 0,
    completionPercent: 100,
    completionState: 'complete',
    eligibility: {
      state: 'unknown',
      reasons: ['pending-decisions'],
      missingSignals: ['missing-evidence-signal', 'missing-learnings-signal'],
    },
  };

  assert.equal(
    summarizeEligibilityReasons(summary),
    'pending-decisions, missing-evidence-signal, missing-learnings-signal',
  );
  assert.equal(
    summarizeEligibilityReasons({
      ...summary,
      eligibility: { state: 'eligible', reasons: [], missingSignals: [] },
    }),
    'ready',
  );
});

test('sortProjectAnalyticsForDisplay orders newest projects first then by name', () => {
  const projects: RunProjectAnalyticsSummary[] = [
    {
      project: 'zeta',
      familyCount: 1,
      runCount: 1,
      activeFamilyCount: 0,
      completedFamilyCount: 1,
      eligibleFamilyCount: 0,
      blockedFamilyCount: 0,
      unknownFamilyCount: 1,
      latestRunAt: '2026-05-04T10:00:00.000Z',
    },
    {
      project: 'alpha',
      familyCount: 1,
      runCount: 1,
      activeFamilyCount: 0,
      completedFamilyCount: 1,
      eligibleFamilyCount: 0,
      blockedFamilyCount: 0,
      unknownFamilyCount: 1,
      latestRunAt: '2026-05-04T10:00:00.000Z',
    },
    {
      project: 'latest',
      familyCount: 1,
      runCount: 1,
      activeFamilyCount: 1,
      completedFamilyCount: 0,
      eligibleFamilyCount: 0,
      blockedFamilyCount: 1,
      unknownFamilyCount: 0,
      latestRunAt: '2026-05-04T12:00:00.000Z',
    },
  ];

  assert.deepEqual(
    sortProjectAnalyticsForDisplay(projects).map((project) => project.project),
    ['latest', 'alpha', 'zeta'],
  );
});
