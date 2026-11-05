import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Run, RunnerSessionUsage } from '@farmslot/protocol';

import { buildFamilyObservabilityTokenSummary } from '../family-observability/token-summary.js';
import { makeRun } from '../run-completion/test-fixtures.js';

import {
  allRunSessionUsageReceipts,
  runSessionUsageReceipts,
  sessionUsageContributions,
} from './session-usage-selection.js';

function run(id: string, index: number, totalTokens: number | null, costUsd: number | null): Run {
  const result = makeRun({
    id,
    flowType: 'dev',
    createdAt: `2026-11-05T00:00:0${index}Z`,
    metrics: { nudgeCount: 0, runner: 'codex', model: 'worker' },
  });
  result.sessionUsage = [
    {
      runner: 'api:fixture',
      runnerSessionId: 'shared-helper',
      kind: 'helper',
      identityKind: 'request',
      actualModel: 'cost-model',
      model: 'cost-model',
      role: 'grade',
      runId: id,
      flowType: 'dev',
      source: 'provider-response',
      totalTokens,
      costUsd,
      costStatus: costUsd === null ? 'unpriced' : 'estimated',
      ...(costUsd === null ? { costReason: 'No verified price' } : {}),
      measuredAt: result.createdAt,
      scope: 'session-total',
    },
  ];
  return result;
}
function sum(rows: RunnerSessionUsage[], field: 'totalTokens' | 'costUsd'): number {
  return rows.reduce((total, row) => total + (row[field] ?? 0), 0);
}

test('verified cost-only provider receipts contribute USD without inventing token totals', () => {
  const source = run('one', 1, null, 0.25);
  assert.equal(allRunSessionUsageReceipts(source)[0].costUsd, 0.25);
  const verified = runSessionUsageReceipts(source);
  assert.equal(verified.length, 1);
  assert.equal(verified[0].totalTokens, null);
  const rows = sessionUsageContributions([source]).get(source.id)!;
  assert.equal(rows[0].costUsd, 0.25);
  assert.equal(rows[0].totalTokens, null);
});

test('shared cost-only snapshots count once and later cost growth contributes only its increment', () => {
  const rows = [
    ...sessionUsageContributions([
      run('one', 1, null, 0.25),
      run('two', 2, null, 0.25),
      run('three', 3, null, 0.5),
    ]).values(),
  ].flat();
  assert.equal(sum(rows, 'costUsd'), 0.5);
  assert.ok(rows.every((row) => row.totalTokens === null));
});

test('token and money high-water marks survive alternating partial observations independently', () => {
  const rows = [
    ...sessionUsageContributions([
      run('tokens-one', 1, 100, null),
      run('cost-one', 2, null, 0.25),
      run('tokens-two', 3, 150, null),
      run('cost-two', 4, null, 0.5),
      run('tokens-repeat', 5, 150, null),
      run('cost-repeat', 6, null, 0.5),
    ]).values(),
  ].flat();
  assert.equal(sum(rows, 'totalTokens'), 150);
  assert.equal(sum(rows, 'costUsd'), 0.5);
  assert.equal(rows.filter((row) => row.costUsd !== null && row.costUsd !== undefined).length, 2);
});

for (const cost of [0, 0.25])
  test(`family/model accounting preserves known cost ${cost} with unknown tokens`, () => {
    const source = run('priced-only', 1, null, cost);
    const summary = buildFamilyObservabilityTokenSummary([source], source.id);
    assert.equal(summary.familyTotalCostEstimate, cost);
    assert.equal(summary.byModel.find((row) => row.model === 'cost-model')?.costEstimate, cost);
    assert.equal(summary.runsWithMetrics, 1);
    assert.equal(source.sessionUsage![0].totalTokens, null);
  });
