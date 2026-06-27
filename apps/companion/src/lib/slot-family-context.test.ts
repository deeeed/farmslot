import { strict as assert } from 'node:assert';
import test from 'node:test';

import type { FamilyObservabilitySnapshot } from '@farmslot/protocol';

import { summarizeSlotFamilyContext } from './slot-family-context';

function snapshot(
  overrides: Partial<FamilyObservabilitySnapshot> = {},
): FamilyObservabilitySnapshot {
  return {
    familyId: 'family-1',
    familyRootTicketOrPr: 'PROJ-123',
    project: 'farmslot',
    generatedAt: '2026-05-20T12:00:00.000Z',
    latestRunId: 'run-2',
    latestPrNumber: 42,
    workflowState: 'complete',
    familyRunCount: 2,
    activeRunCount: 0,
    summary: 'Family summary',
    runs: [
      {
        runId: 'run-1',
        familyId: 'family-1',
        flowType: 'fix-bug',
        lane: 'production',
        status: 'done',
        project: 'farmslot',
        ticketOrPr: 'PROJ-123',
        branch: null,
        prNumber: 42,
        summary: null,
        createdAt: '2026-05-20T10:00:00.000Z',
        updatedAt: '2026-05-20T11:00:00.000Z',
        slotId: 'runner-local-fs-1',
        workerReport: null,
        workerLearnings: null,
        recipeJson: null,
        recipeQualityArtifact: null,
        recipeQuality: { semantic: 'unknown', source: 'missing', reasoning: '' },
        diffStat: { available: true, files: 1, additions: 5, deletions: 1 },
        artifacts: [
          {
            runId: 'run-1',
            familyId: 'family-1',
            path: 'artifacts/before-login.png',
            purpose: 'screenshot-before',
            source: 'artifact-manifest',
          },
          {
            runId: 'run-1',
            familyId: 'family-1',
            path: 'artifacts/after-login.png',
            purpose: 'screenshot-after',
            source: 'artifact-manifest',
          },
        ],
        learnings: [],
        steps: [],
        acceptanceCriteria: [],
        ciChecks: [],
        selfReview: { verdict: null, summary: null, issues: [] },
        familyScope: null,
        decisions: [
          {
            id: 'retro-1',
            type: 'retrospective',
            title: 'Retro',
            description: 'Review run.',
            actions: [],
            createdAt: '2026-05-20T11:00:00.000Z',
          },
        ],
        missingData: [],
      },
    ],
    relatedByTicket: [],
    evidence: [
      {
        runId: 'run-1',
        familyId: 'family-1',
        path: 'artifacts/before-login.png',
        purpose: 'screenshot-before',
        source: 'artifact-manifest',
      },
      {
        runId: 'run-1',
        familyId: 'family-1',
        path: 'artifacts/after-login.png',
        purpose: 'screenshot-after',
        source: 'artifact-manifest',
      },
    ],
    learnings: [],
    diffStat: { available: true, files: 3, additions: 20, deletions: 4 },
    recipeQuality: { semantic: 'good', score: 92, source: 'recipe-quality', reasoning: 'solid' },
    missingData: [],
    ...overrides,
  };
}

test('summarizeSlotFamilyContext exposes compact family workspace metrics', () => {
  assert.deepEqual(summarizeSlotFamilyContext(snapshot()), {
    familyId: 'family-1',
    title: 'PROJ-123',
    workflowState: 'complete',
    runs: 2,
    activeRuns: 0,
    evidence: 2,
    visualPairs: 1,
    visualPairLabel: '1 pair',
    diffLabel: '3 files · +20 -4',
    recipeQualityLabel: 'good · 92',
    retrospectives: 1,
    pendingRetrospectives: 1,
    retrospectiveSignals: [
      {
        runId: 'run-1',
        decisionId: 'retro-1',
        title: 'Retro',
        runTitle: 'PROJ-123',
        pending: true,
        createdAt: '2026-05-20T11:00:00.000Z',
        artifactCount: 2,
        visualPairs: 1,
        primaryVisualPair: {
          beforePath: 'artifacts/before-login.png',
          afterPath: 'artifacts/after-login.png',
          stem: 'login',
        },
        diffLabel: '1 files · +5 -1',
        diffAvailable: true,
      },
    ],
    ledgerLabel: null,
  });
});

test('summarizeSlotFamilyContext includes change ledger footprint when available', () => {
  const summary = summarizeSlotFamilyContext(
    snapshot({
      familyChangeLedger: {
        summary: {
          runsMissingDiff: 0,
          runsWithDiff: 1,
          runsWithContributionDiff: 1,
          runsWithReviewInputDiff: 1,
          runsWithEmptyReviewInputDiff: 0,
          runsWithUnavailableReviewInputDiff: 0,
          totalContributionFiles: 3,
          totalContributionAdditions: 20,
          totalContributionDeletions: 4,
          reviewRounds: 1,
          bugbotFindingsAddressed: 0,
          humanReviewersRequestingChanges: 0,
          humanCommentsAddressed: 0,
          artifactFootprint: {
            count: 9,
            bytes: 2048,
            byPurpose: [],
            bySource: [],
            byExtension: [],
          },
        },
        entries: [
          {
            runId: 'run-1',
            familyId: 'family-1',
            familyRootTicketOrPr: 'PROJ-123',
            ticketOrPr: 'PROJ-123',
            flowType: 'fix-bug',
            lane: 'production',
            project: 'farmslot',
            branch: null,
            createdAt: '2026-05-20T10:00:00.000Z',
            changeKind: 'contribution',
            prNumber: 42,
            contributionDiff: {
              source: 'artifact',
              available: true,
              kind: 'contribution',
              files: 3,
              additions: 20,
              deletions: 4,
            },
            artifactFootprint: {
              count: 9,
              bytes: 2048,
              byPurpose: [],
              bySource: [],
              byExtension: [],
            },
            taskInputArtifacts: [],
            missingData: [],
          },
        ],
      },
    }),
  );

  assert.equal(summary?.ledgerLabel, '1/1 diffs · 9 artifacts');
});
