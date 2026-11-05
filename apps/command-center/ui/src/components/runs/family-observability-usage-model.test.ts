import assert from 'node:assert/strict';
import test from 'node:test';

import type { FamilyUsageReviewRound, RunnerSessionUsage } from '@farmslot/protocol';

import {
  buildUsageAttribution,
  roundUsageTotals,
  summarizeUsage,
  usageAccountingState,
  usageBreakdown,
  usageIntervalDuration,
  usageIntervalSummary,
} from './family-observability-usage-model.js';

function receipt(overrides: Partial<RunnerSessionUsage> = {}): RunnerSessionUsage {
  return {
    runner: 'codex',
    actualModel: 'gpt-6.1-sol',
    runnerSessionId: 'worker',
    measuredAt: '2026-11-04T23:09:23.239Z',
    source: 'runner-transcript',
    inputTokens: 39_986_442,
    cacheRead: 39_031_040,
    outputTokens: 115_009,
    totalTokens: 40_101_451,
    costUsd: null,
    ...overrides,
  };
}

test('F411 uses the canonical total without counting cached input twice', () => {
  assert.deepEqual(summarizeUsage([receipt()]), {
    tokens: 40_101_451,
    cost: null,
    measured: 1,
    missing: 0,
    unpriced: 1,
  });
});

test('absence, measured zero, and a partially priced subtotal stay distinct', () => {
  assert.deepEqual(summarizeUsage([receipt({ source: 'unavailable', totalTokens: null })]), {
    tokens: null,
    cost: null,
    measured: 0,
    missing: 1,
    unpriced: 0,
  });
  assert.deepEqual(summarizeUsage([receipt({ totalTokens: 0, costUsd: 0 })]), {
    tokens: 0,
    cost: 0,
    measured: 1,
    missing: 0,
    unpriced: 0,
  });
  const partial = summarizeUsage([receipt(), receipt({ totalTokens: 100, costUsd: 0.02 })]);
  assert.equal(partial.cost, 0.02);
  assert.equal(partial.unpriced, 1);
  assert.equal(summarizeUsage([receipt({ totalTokens: null, costUsd: 0.2 })]).cost, 0.2);
});

test('run accounting never treats acquisition times as observation history', () => {
  const points = buildUsageAttribution([
    {
      runId: 'later',
      sessionId: 'b',
      usage: receipt({ measuredAt: '2026-11-05T01:00:00Z', totalTokens: 30, costUsd: 0.03 }),
    },
    {
      runId: 'first',
      sessionId: 'a',
      usage: receipt({ measuredAt: '2026-11-04T23:00:00Z', totalTokens: 10, costUsd: 0.01 }),
    },
    {
      runId: 'parallel',
      sessionId: 'c',
      usage: receipt({ measuredAt: '2026-11-04T23:00:00Z', totalTokens: 20 }),
    },
    {
      runId: 'missing',
      sessionId: 'd',
      usage: receipt({ source: 'unavailable', totalTokens: null }),
    },
  ]);
  assert.deepEqual(
    points.map((p) => [p.index, p.tokens, p.cost, p.unpriced]),
    [
      [0, 30, 0.03, 0],
      [1, 40, 0.04, 0],
      [2, 60, 0.04, 1],
    ],
  );
  assert.deepEqual(
    points.map((p) => p.runIds),
    [['later'], ['first'], ['parallel']],
  );
});

test('model and runner breakdowns sum the same canonical contributions', () => {
  const rows = [
    receipt(),
    receipt({ runner: 'other', actualModel: 'priced', totalTokens: 25, costUsd: 0.1 }),
  ];
  assert.equal(
    usageBreakdown(rows, 'runner').reduce((sum, row) => sum + (row.tokens ?? 0), 0),
    40_101_476,
  );
  assert.equal(usageBreakdown(rows, 'model').find((row) => row.label === 'priced')?.cost, 0.1);
  assert.equal(
    usageBreakdown(rows, 'model').find((row) => row.label === 'gpt-6.1-sol')?.unpriced,
    1,
  );
});

test('parallel review and fix intervals contribute wall time once, never time at an open gate', () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 4, 23, 0, seconds)).toISOString();
  assert.equal(
    usageIntervalDuration([
      { startedAt: at(0), completedAt: at(60) },
      { startedAt: at(20), completedAt: at(90) },
      { startedAt: at(90), completedAt: at(120) },
    ]),
    120_000,
  );
  assert.equal(usageIntervalDuration([{ startedAt: at(120), completedAt: null }]), null);
  assert.equal(usageIntervalDuration([{ startedAt: at(20), completedAt: at(0) }]), null);
  assert.equal(usageIntervalDuration([]), null);
  assert.equal(
    usageIntervalDuration([
      { startedAt: at(0), completedAt: at(60) },
      { startedAt: at(60), completedAt: null },
    ]),
    60_000,
    'an open interval must not erase completed wall time',
  );
  assert.deepEqual(
    usageIntervalSummary([
      { startedAt: at(0), completedAt: at(60) },
      { startedAt: at(60), completedAt: null },
    ]),
    { durationMs: 60_000, incomplete: 1 },
  );
});

test('empty selected-run accounting is distinct from a new measured zero', () => {
  assert.equal(usageAccountingState([], 1), 'no-attributed-measurement');
  assert.equal(usageAccountingState([], 0), 'not-captured');
  assert.equal(
    usageAccountingState(
      [{ runId: 'run', sessionId: 'zero', usage: receipt({ totalTokens: 0, costUsd: 0 }) }],
      1,
    ),
    'captured',
  );
});

test('a review receipt is not presented as the cost of unmeasured fixes or shared rounds', () => {
  const round: FamilyUsageReviewRound = {
    id: 'round',
    runId: 'run',
    reviewId: 'review',
    roundNumber: 1,
    runner: 'codex',
    model: 'gpt-6.1-sol',
    review: { startedAt: null, completedAt: null },
    fixes: [],
    costScope: 'session-total',
    usageOrigin: 'round-receipt',
    usage: receipt({ costUsd: 0.25 }),
  };
  assert.equal(
    roundUsageTotals(round).addedCost,
    null,
    'a final session total does not prove marginal round cost',
  );
  assert.equal(
    roundUsageTotals(round).reviewCost,
    0.25,
    'the recorded session cost remains visible',
  );
  assert.equal(
    roundUsageTotals({ ...round, fixes: [{ startedAt: null, completedAt: null }] }).addedCost,
    null,
  );
  assert.equal(roundUsageTotals({ ...round, costScope: 'shared-session' }).reviewCost, 0.25);
  assert.equal(
    roundUsageTotals({ ...round, usage: receipt({ totalTokens: null, costUsd: 0.1 }) }).reviewCost,
    0.1,
  );
  assert.equal(roundUsageTotals({ ...round, costScope: 'unavailable' }).tokens, null);
});

test('breakdowns keep canonical cost-only increments separate from inventory coverage', () => {
  const costOnly = receipt({ totalTokens: null, costUsd: 0.25 });
  const inventory = [
    costOnly,
    receipt({ runnerSessionId: 'missing', source: 'unavailable', totalTokens: null }),
  ];
  const row = usageBreakdown([costOnly], 'runner', inventory)[0];
  assert.equal(row.cost, 0.25);
  assert.equal(row.tokens, null);
  assert.equal(row.missing, 2);
  assert.equal(
    usageBreakdown([], 'runner', inventory)[0].cost,
    null,
    'selected-run accounting must not substitute a reused session total',
  );
});
