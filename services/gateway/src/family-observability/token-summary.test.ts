import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run } from '@farmslot/protocol';

import { buildFamilyObservabilityTokenSummary } from './token-summary.js';

function makeRun(overrides: Partial<Run> & Pick<Run, 'id' | 'createdAt'>): Run {
  return {
    familyId: 'family-1',
    flowType: 'fix-bug',
    lane: 'production',
    status: 'done',
    project: 'demo',
    ticketOrPr: 'PROJ-1',
    branch: 'fix/proj-1',
    prNumber: null,
    updatedAt: overrides.createdAt,
    slotId: 'slot-1',
    taskFile: '.task/TASK.md',
    metrics: { nudgeCount: 0, model: 'claude-sonnet', runner: 'claude' },
    steps: [],
    decisions: [],
    tags: [],
    ...overrides,
  } as Run;
}

test('buildFamilyObservabilityTokenSummary rolls worker and review tokens without double-counting loops', () => {
  const summary = buildFamilyObservabilityTokenSummary(
    [
      makeRun({
        id: 'family-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        metrics: {
          nudgeCount: 0,
          model: 'claude-sonnet',
          runner: 'claude',
          sessionTotalTokens: 10_000,
          sessionInputTokens: 6000,
          sessionOutputTokens: 4000,
          costEstimate: 0.5,
        },
        engineState: {
          publishGate: {
            reviews: [
              {
                id: 'review-a',
                model: 'gpt-5',
                usage: { totalTokens: 500, inputTokens: 300, outputTokens: 200 },
              },
            ],
          },
        } as Run['engineState'],
      }),
      makeRun({
        id: 'pc-1',
        createdAt: '2026-01-02T00:00:00.000Z',
        flowType: 'pr-complete',
        metrics: {
          nudgeCount: 0,
          model: 'claude-sonnet',
          runner: 'claude',
          sessionTotalTokens: 3000,
          costEstimate: 0.2,
        },
      }),
    ],
    'family-1',
  );

  assert.equal(summary.familyTotalTokens, 13_500);
  assert.equal(
    summary.familyTotalCostEstimate,
    null,
    'Unpriced reviewer spend cannot silently disappear from cost',
  );
  assert.equal(summary.runPoints[0]?.reviewTokens, 500);
  assert.equal(summary.runPoints[1]?.deltaTokens, 3000);
  assert.equal(summary.milestoneRunPoints.length, 2);
  assert.equal(summary.milestoneRunPoints[1]?.label, 'pr-complete #1');
  assert.equal(
    summary.byModel.some((entry) => entry.model === 'gpt-5'),
    true,
  );
});

test('buildFamilyObservabilityTokenSummary records missing run ids', () => {
  const summary = buildFamilyObservabilityTokenSummary(
    [
      makeRun({ id: 'run-a', createdAt: '2026-01-01T00:00:00.000Z' }),
      makeRun({
        id: 'run-b',
        createdAt: '2026-01-02T00:00:00.000Z',
        metrics: {
          nudgeCount: 0,
          model: 'claude-sonnet',
          runner: 'claude',
          sessionTotalTokens: 100,
        },
      }),
    ],
    'family-1',
  );

  assert.deepEqual(summary.missingRunIds, ['run-a']);
  assert.equal(summary.runsMissingMetrics, 1);
});

test('all pipeline sessions count once across reused conversations, including helpers', () => {
  const session = (
    runnerSessionId: string,
    totalTokens: number,
    role: string,
    runner = 'claude',
  ) => ({
    runner,
    runnerSessionId,
    model: 'fixture-model',
    actualModel: 'fixture-model',
    identityKind: runner.startsWith('api:') ? ('request' as const) : ('conversation' as const),
    source: 'runner-transcript' as const,
    measuredAt: '2026-11-05T00:00:00Z',
    role,
    totalTokens,
    costUsd: 0,
    costStatus: 'estimated' as const,
  });
  const summary = buildFamilyObservabilityTokenSummary(
    [
      makeRun({
        id: 'one',
        createdAt: '2026-11-04T00:00:00Z',
        sessionUsage: [session('worker', 100, 'dev'), session('review', 40, 'review')],
      }),
      makeRun({
        id: 'two',
        createdAt: '2026-11-05T00:00:00Z',
        sessionUsage: [
          session('worker', 150, 'review-fix'),
          session('review', 60, 'review'),
          session('summary', 30, 'summary', 'api:fixture'),
        ],
      }),
    ],
    'one',
  );
  assert.equal(summary.familyTotalTokens, 240);
  assert.equal(summary.runPoints[0].stepTokens, 140);
  assert.equal(summary.runPoints[1].stepTokens, 100);
  assert.equal(summary.runPoints[1].helperTokens, 30);
  assert.equal(summary.byModel[0].total, 240);
  assert.equal(summary.familyTotalCostEstimate, 0);
});

test('a review-pr generation delta is not added to its canonical conversation total', () => {
  const summary = buildFamilyObservabilityTokenSummary(
    [
      makeRun({
        id: 'review-generation',
        createdAt: '2026-11-05T00:00:00Z',
        flowType: 'review-pr',
        metrics: {
          nudgeCount: 0,
          runner: 'claude',
          model: 'fixture',
          runnerSessionId: 'review-worker',
          sessionTotalTokens: 20,
          sessionUsageScope: 'review-generation-delta',
        },
        sessionUsage: [
          {
            runner: 'claude',
            runnerSessionId: 'review-worker',
            role: 'review',
            kind: 'agent',
            source: 'runner-transcript',
            totalTokens: 100,
            measuredAt: '2026-11-05T00:00:00Z',
          },
        ],
      }),
    ],
    'review-generation',
  );
  assert.equal(summary.familyTotalTokens, 100);
});
