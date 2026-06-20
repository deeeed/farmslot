import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  FamilyChangeLedgerEntry,
  FamilyObservabilityRunSummary,
  FamilyObservabilitySnapshot,
} from '../../src/contracts/index.js';
import { buildFamilyIterationLedgerPresentation } from '../../src/runs/family-iteration-ledger.js';

function makeRun(overrides: Partial<FamilyObservabilityRunSummary>): FamilyObservabilityRunSummary {
  return {
    runId: overrides.runId ?? 'root-run-12345678',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    flowType: overrides.flowType ?? 'dev',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    status: overrides.status ?? 'done',
    project: overrides.project ?? 'example',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    branch: overrides.branch ?? null,
    prNumber: overrides.prNumber ?? 123,
    summary: overrides.summary ?? 'Implemented original task',
    createdAt: overrides.createdAt ?? '2026-06-18T12:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-06-18T13:00:00.000Z',
    completedAt: overrides.completedAt,
    slotId: overrides.slotId ?? 'macwork-core-1',
    workerReport: overrides.workerReport ?? null,
    workerLearnings: overrides.workerLearnings ?? null,
    recipeJson: overrides.recipeJson ?? null,
    recipeProvenance: overrides.recipeProvenance,
    recipeQualityArtifact: overrides.recipeQualityArtifact ?? null,
    recipeQuality: overrides.recipeQuality ?? {
      source: 'missing',
      semantic: 'unknown',
      score: null,
      reasoning: 'missing',
    },
    diffStat: overrides.diffStat ?? { available: true, files: 2, additions: 10, deletions: 1 },
    artifacts: overrides.artifacts ?? [],
    learnings: overrides.learnings ?? [],
    steps: overrides.steps ?? [],
    acceptanceCriteria: overrides.acceptanceCriteria ?? [],
    ciChecks: overrides.ciChecks ?? [],
    selfReview: overrides.selfReview ?? { verdict: null, summary: null, issues: [] },
    familyScope: overrides.familyScope ?? null,
    humanGrade: overrides.humanGrade,
    proofTargets: overrides.proofTargets,
    decisions: overrides.decisions ?? [],
    metrics: overrides.metrics,
    links: overrides.links,
    missingData: overrides.missingData ?? [],
  };
}

function makeLedgerEntry(overrides: Partial<FamilyChangeLedgerEntry>): FamilyChangeLedgerEntry {
  return {
    runId: overrides.runId ?? 'root-run-12345678',
    familyId: overrides.familyId ?? 'family-1',
    parentRunId: overrides.parentRunId ?? null,
    familyRootTicketOrPr: overrides.familyRootTicketOrPr ?? 'PROJ-1',
    lane: overrides.lane ?? 'production',
    variant: overrides.variant ?? null,
    flowType: overrides.flowType ?? 'dev',
    project: overrides.project ?? 'example',
    ticketOrPr: overrides.ticketOrPr ?? 'PROJ-1',
    branch: overrides.branch ?? null,
    prNumber: overrides.prNumber ?? 123,
    createdAt: overrides.createdAt ?? '2026-06-18T12:00:00.000Z',
    completedAt: overrides.completedAt,
    changeKind: overrides.changeKind ?? 'contribution',
    contributionDiff: overrides.contributionDiff ?? {
      source: 'artifact',
      available: true,
      files: 2,
      additions: 10,
      deletions: 1,
      kind: 'contribution',
    },
    inputDiff: overrides.inputDiff,
    legacyDiffFallback: overrides.legacyDiffFallback,
    inputCommit: overrides.inputCommit,
    reviewSignals: overrides.reviewSignals,
    artifactFootprint: overrides.artifactFootprint ?? {
      count: 1,
      bytes: 1000,
      byPurpose: [],
      bySource: [],
      byExtension: [],
    },
    taskInputArtifacts: overrides.taskInputArtifacts ?? [],
    missingData: overrides.missingData ?? [],
  };
}

function makeSnapshot(
  runs: FamilyObservabilityRunSummary[],
  entries: FamilyChangeLedgerEntry[],
): Pick<FamilyObservabilitySnapshot, 'runs' | 'familyChangeLedger'> {
  return {
    runs,
    familyChangeLedger: {
      summary: {
        runsWithDiff: entries.length,
        runsMissingDiff: 0,
        runsWithContributionDiff: entries.length,
        runsWithReviewInputDiff: 0,
        runsWithEmptyReviewInputDiff: 0,
        runsWithUnavailableReviewInputDiff: 0,
        totalContributionFiles: 0,
        totalContributionAdditions: 0,
        totalContributionDeletions: 0,
        reviewRounds: 0,
        bugbotFindingsAddressed: 0,
        humanReviewersRequestingChanges: 0,
        humanCommentsAddressed: 0,
        artifactFootprint: { count: 0, bytes: 0, byPurpose: [], bySource: [], byExtension: [] },
      },
      entries,
    },
  };
}

test('iteration ledger presents the root task before follow-up ledger entries', () => {
  const root = makeLedgerEntry({
    runId: 'root-run-12345678',
    parentRunId: null,
    flowType: 'dev',
    createdAt: '2026-06-18T12:00:00.000Z',
  });
  const followUp = makeLedgerEntry({
    runId: 'followup-12345678',
    parentRunId: root.runId,
    flowType: 'pr-complete',
    createdAt: '2026-06-18T16:00:00.000Z',
    inputDiff: {
      source: 'artifact',
      available: true,
      files: 3,
      additions: 40,
      deletions: 5,
      kind: 'review-input',
    },
  });

  const presentation = buildFamilyIterationLedgerPresentation(
    makeSnapshot(
      [
        makeRun({ runId: followUp.runId, parentRunId: root.runId, flowType: 'pr-complete' }),
        makeRun({ runId: root.runId, parentRunId: null, flowType: 'dev' }),
      ],
      [followUp, root],
    ),
  );

  assert.deepEqual(
    presentation.cards.map((card) => card.runId),
    [root.runId, followUp.runId],
  );
  assert.equal(presentation.cards[0].reason, 'Original task implementation');
  assert.equal(presentation.cards[1].reviewedInputLabel, '3 files · +40 -5');
});

test('iteration ledger appends fallback cards when ledger entries are partial', () => {
  const root = makeLedgerEntry({
    runId: 'root-run-12345678',
    parentRunId: null,
    flowType: 'dev',
    createdAt: '2026-06-18T12:00:00.000Z',
  });
  const missingFromLedger = makeRun({
    runId: 'followup-12345678',
    parentRunId: root.runId,
    flowType: 'pr-complete',
    createdAt: '2026-06-18T16:00:00.000Z',
    diffStat: { available: true, files: 4, additions: 8, deletions: 2 },
  });

  const presentation = buildFamilyIterationLedgerPresentation(
    makeSnapshot(
      [makeRun({ runId: root.runId, parentRunId: null, flowType: 'dev' }), missingFromLedger],
      [root],
    ),
  );

  assert.deepEqual(
    presentation.cards.map((card) => card.runId),
    [root.runId, missingFromLedger.runId],
  );
  assert.equal(presentation.cards[1].diffLabel, '4 files · +8 -2');
});

test('iteration ledger calls out CI-driven follow-ups', () => {
  const root = makeLedgerEntry({ runId: 'root-run-12345678' });
  const followUp = makeLedgerEntry({
    runId: 'ci-followup-12345678',
    parentRunId: root.runId,
    flowType: 'pr-complete',
    createdAt: '2026-06-18T16:00:00.000Z',
  });

  const presentation = buildFamilyIterationLedgerPresentation(
    makeSnapshot(
      [
        makeRun({ runId: root.runId }),
        makeRun({
          runId: followUp.runId,
          parentRunId: root.runId,
          flowType: 'pr-complete',
          ciChecks: [{ name: 'Test lint', status: 'completed', conclusion: 'failure' }],
          decisions: [
            {
              id: 'decision-ci',
              type: 'ci_ci_failed',
              title: 'ci failed',
              description: 'CI failed',
              actions: [],
              createdAt: '2026-06-18T16:10:00.000Z',
            },
          ],
        }),
      ],
      [root, followUp],
    ),
  );

  const ciCard = presentation.cards[1];
  assert.equal(ciCard.reason, 'Follow-up for CI failure');
  assert.equal(ciCard.ciLabel, '1 failed check · 1 CI decision');
  assert.equal(presentation.summary.ciIssueRuns, 1);
});
