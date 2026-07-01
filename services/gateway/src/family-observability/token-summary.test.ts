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
            independentReviews: [
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
  assert.equal(summary.familyTotalCostEstimate, 0.7);
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
