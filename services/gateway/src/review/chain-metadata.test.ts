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
  assert.match(rows[2].costReason ?? '', /unpriced or uncaptured/);
});

test('an uncaptured replacement cannot turn a captured subtotal into a total', () => {
  const run = record('replacement', 1, 3);
  run.sessionUsage!.push({
    ...run.sessionUsage![0],
    runnerSessionId: 'replacement-session',
    source: 'unavailable',
    totalTokens: null,
    costUsd: null,
    costStatus: 'unpriced',
  });
  assert.equal(reviewChainWithMetrics([entry(run, 1)], [run])[0].costUsd, null);
});

test('a token-only retained baseline cannot price a later cumulative receipt', () => {
  const prior = record('unpriced-prior', 1, null, 'shared');
  const current = record('priced-current', 2, 8, 'shared');
  const rows = reviewChainWithMetrics(
    [entry(prior, 1), entry(current, 2, 'warm')],
    [prior, current],
  );
  assert.equal(rows[1].costUsd, null);
});

test('a fully priced retained conversation with no growth records zero generation cost', () => {
  const prior = record('prior-zero', 1, 3, 'shared-zero');
  const current = record('current-zero', 2, 3, 'shared-zero');
  current.sessionUsage![0].totalTokens = prior.sessionUsage![0].totalTokens;
  const rows = reviewChainWithMetrics(
    [entry(prior, 1), entry(current, 2, 'warm')],
    [prior, current],
  );
  assert.equal(rows[1].costUsd, 0);
});
