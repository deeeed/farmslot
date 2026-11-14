import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { EvalBenchTrial } from '../src/contracts/eval-bench.js';
import { evalBenchCostSaving, evalBenchRollups } from '../src/evals/bench-rollup.js';

function trial(overrides: Partial<EvalBenchTrial> = {}): EvalBenchTrial {
  return {
    runId: 'trial',
    sourceSha256: 'hash',
    dataset: 'bench',
    item: 'C01',
    problemType: 'fix-bug',
    area: 'Core',
    sizeClass: 'medium',
    model: 'Model',
    modelId: 'model',
    route: 'hosted',
    effort: 'high',
    reference: { repo: 'owner/repo', base: 'base', head: 'original', pr: 1 },
    verdict: 'ACCEPTABLE-ALT',
    verdictVsMerged: 'PARTIAL',
    mergeable: 'no: needs review',
    unscored: null,
    usage: {
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      reasoningTokens: 1,
      costUsd: 2,
      costNote: null,
      turns: 5,
      wallMinutes: 1,
    },
    original: null,
    ...overrides,
  };
}

test('rollup uses pre-review scores, keeps mergeability separate and charges unscored attempts', () => {
  const rows = evalBenchRollups([
    trial(),
    trial({ runId: 'second', mergeable: 'yes (nit)', item: 'C02' }),
    trial({ runId: 'cancel', unscored: 'policy-cancel', verdict: 'MATCHES-REF' }),
    trial({ runId: 'local', usage: { ...trial().usage, costUsd: null } }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].solved, 3);
  assert.equal(rows[0].scored, 3);
  assert.equal(rows[0].mergeable, 1);
  assert.equal(rows[0].unscored, 1);
  assert.equal(rows[0].cases, 2);
  assert.equal(rows[0].costUsd, 6);
  assert.equal(rows[0].pricedTrials, 3);
  assert.equal(rows[0].turns, 20);
});

test('different routes and efforts stay separate and missing costs produce no saving', () => {
  assert.equal(
    evalBenchRollups([trial(), trial({ effort: 'low' }), trial({ route: 'local' })]).length,
    3,
  );
  assert.equal(evalBenchCostSaving(trial()), null);
  const original = {
    repo: 'owner/repo',
    head: 'original',
    runId: 'original-run',
    model: 'Original',
    scope: 'first-output',
    startedAt: '2026-01-01',
    completedAt: '2026-01-02',
    sourceSha256: 'hash',
    usage: { ...trial().usage, costUsd: 10 },
  };
  assert.equal(evalBenchCostSaving(trial({ original })), 0.8);
  assert.equal(
    evalBenchCostSaving(trial({ original, usage: { ...trial().usage, costUsd: null } })),
    null,
  );
});
