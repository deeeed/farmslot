import assert from 'node:assert/strict';
import { test } from 'node:test';

import type {
  FamilyObservabilityRunSummary,
  FamilyObservabilityTokenRunPoint,
  GateSummary,
} from '@farmslot/protocol';

import {
  buildClientFamilyTokenSummary,
  buildRunTokenSummary,
  filterPointsForTrajectory,
  resolveFamilyTokenSummary,
} from './family-observability-token-model.js';

function run(
  runId: string,
  createdAt: string,
  metrics: FamilyObservabilityRunSummary['metrics'] = undefined,
  overrides: Partial<FamilyObservabilityRunSummary> = {},
): FamilyObservabilityRunSummary {
  return {
    runId,
    familyId: 'family-1',
    flowType: 'fix-bug',
    lane: 'production',
    status: 'done',
    project: 'demo',
    ticketOrPr: 'PROJ-1',
    branch: 'fix/proj-1',
    prNumber: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: createdAt,
    slotId: 'slot-1',
    workerReport: { available: false },
    workerLearnings: { available: false },
    recipeJson: { available: false },
    recipeQuality: { semantic: 'unknown' },
    diffStat: { available: false, files: 0, additions: 0, deletions: 0 },
    artifacts: [],
    learnings: { available: false },
    steps: [],
    acceptanceCriteria: [],
    ciChecks: [],
    selfReview: { available: false },
    familyScope: 'production',
    humanGrade: { available: false },
    proofTargets: [],
    missingData: [],
    metrics,
    ...overrides,
  } as FamilyObservabilityRunSummary;
}

test('resolveFamilyTokenSummary prefers gateway tokenSummary', () => {
  const gatewaySummary = {
    familyTotalTokens: 99,
    familyTotalCostEstimate: null,
    runsWithMetrics: 1,
    runsMissingMetrics: 0,
    missingRunIds: [],
    runPoints: [],
    milestoneRunPoints: [],
    byModel: [],
  };
  const resolved = resolveFamilyTokenSummary({
    familyId: 'family-1',
    runs: [],
    tokenSummary: gatewaySummary,
  });
  assert.equal(resolved, gatewaySummary);
});

test('buildClientFamilyTokenSummary orders runs and tracks deltas', () => {
  const summary = buildClientFamilyTokenSummary({
    familyId: 'family-1',
    runs: [
      run('run-b', '2026-01-02T00:00:00.000Z', {
        model: 'claude-sonnet',
        runner: 'claude',
        nudgeCount: 0,
        sessionTotalTokens: 20_000,
        costEstimate: 1.25,
      }),
      run('run-a', '2026-01-01T00:00:00.000Z', {
        model: 'claude-sonnet',
        runner: 'claude',
        nudgeCount: 0,
        sessionTotalTokens: 10_000,
        costEstimate: 0.75,
      }),
    ],
  });

  assert.equal(summary.familyTotalTokens, 30_000);
  assert.equal(summary.runPoints[0]?.runId, 'run-a');
  assert.equal(summary.runPoints[1]?.deltaTokens, 20_000);
  assert.equal(summary.missingRunIds.length, 0);
});

test('filterPointsForTrajectory uses milestoneRunPoints when provided', () => {
  const milestoneRunPoints: FamilyObservabilityTokenRunPoint[] = [
    {
      runId: 'root',
      label: 'family root',
      flowType: 'fix-bug',
      lane: 'production',
      status: 'done',
      createdAt: '2026-01-01T00:00:00.000Z',
      model: null,
      runner: null,
      workerTokens: 100,
      reviewTokens: 0,
      inputTokens: 100,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreation: 0,
      stepTokens: 100,
      stepCostEstimate: null,
      cumulativeTokens: 100,
      cumulativeCostEstimate: null,
      deltaTokens: 100,
      deltaCostEstimate: null,
      hasMetrics: true,
    },
  ];
  const filtered = filterPointsForTrajectory(
    [],
    'pr-complete-milestones',
    'root',
    milestoneRunPoints,
  );
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.label, 'family root');
});

test('buildRunTokenSummary prefers gate summary roles and byModel', () => {
  const gateSummary = {
    kind: 'ready',
    worker: { model: 'claude-sonnet', turns: 12 },
    review: {
      independentReviews: [],
      passingReviews: 0,
      totalUnresolved: 0,
      didAnyReviewTriggerReWork: false,
    },
    tokens: {
      mainWorker: {
        model: 'claude-sonnet',
        input: 1000,
        output: 500,
        cacheRead: 100,
        cacheCreation: 0,
        total: 1600,
        turns: 12,
      },
      reviews: [{ id: 'review-a', model: 'gpt-5', input: 200, output: 100, total: 300 }],
      byModel: [
        {
          model: 'claude-sonnet',
          input: 1000,
          output: 500,
          cacheRead: 100,
          cacheCreation: 0,
          total: 1600,
          turns: 12,
        },
        {
          model: 'gpt-5',
          input: 200,
          output: 100,
          cacheRead: 0,
          cacheCreation: 0,
          total: 300,
          turns: 0,
        },
      ],
      familyTotalTokens: 1900,
      perTurnDetailsAvailable: false,
    },
  } as GateSummary;

  const summary = buildRunTokenSummary(
    run(
      'run-a',
      '2026-01-01T00:00:00.000Z',
      {
        model: 'claude-sonnet',
        runner: 'claude',
        nudgeCount: 0,
        sessionTotalTokens: 1600,
      },
      {
        decisions: [
          {
            id: 'd1',
            type: 'ready',
            title: 'Ready',
            description: 'Ready gate',
            actions: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            payload: { kind: 'ready', gateSummary },
          },
        ] as unknown as FamilyObservabilityRunSummary['decisions'],
      },
    ),
  );

  assert.equal(summary.totalTokens, 1900);
  assert.equal(summary.usesGateSummary, true);
  assert.equal(summary.roles.length, 2);
});
