import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewChainEntry, Run } from '@farmslot/protocol';

import { makeRun } from '../methods/run/test-fixtures.js';

import { reviewChainWithMetrics } from './chain-metadata.js';

function record(id: string, generation: number, costUsd: number | null, session = id): Run {
  const run = makeRun({
    id,
    flowType: 'review-pr',
    createdAt: `2026-11-13T00:0${generation}:00Z`,
    metrics: {
      nudgeCount: 0,
      runner: 'pi',
      model: 'model',
      durationMs: generation * 1000,
    },
  });
  run.sessionUsage = [
    {
      runner: 'pi',
      runnerSessionId: session,
      role: 'review',
      source: 'runner-transcript',
      scope: 'session-total',
      measuredAt: run.createdAt,
      costUsd,
      totalTokens: generation * 100,
      costStatus: costUsd == null ? 'unpriced' : 'estimated',
    },
  ];
  return run;
}
function entry(run: Run, generation: number, mode: 'cold' | 'warm' = 'cold'): ReviewChainEntry {
  return {
    chainId: 'chain',
    generation,
    runId: run.id,
    familyId: run.familyId,
    repository: 'owner/repo',
    prNumber: 1,
    mode,
    validationDepth: 'static-code',
    verdict: 'APPROVE',
    unresolvedCount: 0,
    artifactRefs: [],
    runner: run.metrics.runner,
    model: run.metrics.model,
    createdAt: run.createdAt,
  };
}

test('chain rows carry recorded time, zero cost and warm generation usage without changing history', () => {
  const first = record('one', 1, 3, 'retained');
  const second = record('two', 2, 0);
  const third = record('three', 3, 8, 'retained');
  const chain = [entry(first, 1), entry(second, 2), entry(third, 3, 'warm')];
  const result = reviewChainWithMetrics(chain, [first, second, third]);
  assert.deepEqual(
    result.map((row) => [row.durationMs, row.costUsd]),
    [
      [1000, 3],
      [2000, 0],
      [3000, 5],
    ],
  );
  assert.deepEqual(
    result.map((row) => [row.runId, row.verdict, row.mode]),
    chain.map((row) => [row.runId, row.verdict, row.mode]),
  );
  assert.equal(chain[0].costUsd, undefined, 'presentation must not mutate the frozen summary');
});

test('unpriced receipts and missing warm baselines remain unknown', () => {
  const missing = record('missing', 1, 3, 'retained');
  const warm = record('warm', 2, 8, 'retained');
  const unpriced = record('unpriced', 3, null);
  const rows = reviewChainWithMetrics(
    [entry(missing, 1), entry(warm, 2, 'warm'), entry(unpriced, 3)],
    [warm, unpriced],
  );
  assert.equal(rows[1].costUsd, null);
  assert.equal(rows[1].costReason, 'Earlier session usage unavailable');
  assert.equal(rows[2].costUsd, null);
  assert.equal(rows[2].costReason, 'Cost not recorded');
});
