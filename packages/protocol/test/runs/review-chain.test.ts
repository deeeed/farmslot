import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '../../src/contracts/index.js';
import {
  currentReviewChainEntry,
  observedReviewSessionContinuity,
  reviewChainForRun,
} from '../../src/runs/review-chain.js';

function repeatReviewRun(mode: 'cold' | 'warm'): Run {
  return {
    id: 'review-2',
    familyId: 'family-1',
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
    decisions: [],
    metrics: { nudgeCount: 0, runner: 'codex', model: 'gpt-5.6' },
    repeatReviewContext: {
      version: 1,
      chainId: 'review-1',
      generation: 2,
      priorRunId: 'review-1',
      priorFamilyId: 'family-1',
      repository: 'deeeed/farmslot',
      prNumber: 1,
      priorReviewedHeadSha: 'prior-head',
      currentHeadSha: 'current-head',
      verdict: 'pending',
      unresolvedFindings: [],
      artifactRefs: [],
      farmslotEvidenceRefs: [],
      mode,
      validationDepth: 'static-code',
      priorGenerations: [],
    },
  } as Run;
}

test('review-chain range uses the prior head only for WARM reviews', () => {
  const incremental = currentReviewChainEntry(repeatReviewRun('warm'))!;
  assert.equal(incremental.baseSha, 'prior-head');
  assert.equal(currentReviewChainEntry(repeatReviewRun('cold'))?.baseSha, undefined);
  assert.equal(observedReviewSessionContinuity(incremental), 'unknown');
});

test('review-chain projection keeps every generation ordered with pending counts unknown', () => {
  const run = repeatReviewRun('warm');
  run.id = 'review-3';
  run.repeatReviewContext!.generation = 3;
  run.repeatReviewContext!.priorGenerations = [
    {
      chainId: 'review-1',
      generation: 2,
      runId: 'review-2',
      familyId: 'family-1',
      repository: 'deeeed/farmslot',
      prNumber: 1,
      headSha: 'prior-head',
      mode: 'warm',
      validationDepth: 'static-code',
      verdict: 'pass',
      unresolvedCount: 0,
      artifactRefs: [],
      runner: 'codex',
      model: 'gpt-5.6',
      createdAt: '2026-08-06T01:00:00.000Z',
    },
    {
      chainId: 'review-1',
      generation: 1,
      runId: 'review-1',
      familyId: 'family-1',
      repository: 'deeeed/farmslot',
      prNumber: 1,
      headSha: 'initial-head',
      mode: 'cold',
      validationDepth: 'static-code',
      verdict: 'issues',
      unresolvedCount: 2,
      artifactRefs: [],
      runner: 'claude',
      model: 'opus',
      createdAt: '2026-08-06T00:00:00.000Z',
    },
  ];

  const chain = reviewChainForRun(run);
  assert.deepEqual(
    chain.map((entry) => entry.generation),
    [1, 2, 3],
  );
  assert.equal(chain[2]?.verdict, 'pending');
  assert.equal(chain[2]?.unresolvedCount, null);
});
