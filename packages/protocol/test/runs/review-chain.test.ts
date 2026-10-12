import assert from 'node:assert/strict';
import test from 'node:test';

import type { Run } from '../../src/contracts/index.js';
import {
  currentReviewChainEntry,
  observedReviewSessionContinuity,
  reviewChainForRun,
  savedReviewView,
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

const savedReport = '## Exact report\n' + 'Complete saved evidence.\n'.repeat(150);
function savedRun(action?: 'post' | 'dismiss'): Run {
  return {
    flowType: 'review-pr',
    status: 'done',
    decisions: action
      ? [
          {
            id: 'gate',
            type: 'engine_review_posting',
            resolvedAt: 'now',
            resolvedAction: action,
            selectionData: { recommendation: 'APPROVE', includedIndices: [] },
            payload: { kind: 'review', recommendation: 'old', reviewMd: 'old' },
          },
        ]
      : [],
    reviewResult: {
      recommendation: ' REQUEST_CHANGES ',
      reviewMd: savedReport,
      lineComments: [],
      reviewSnapshot: { headSha: 'a'.repeat(40) },
    },
  } as unknown as Run;
}
test('saved post, dismiss and auto-finish preserve raw result independently of publication', () => {
  for (const action of ['post', 'dismiss', undefined] as const) {
    const run = savedRun(action);
    const view = savedReviewView(run)!;
    assert.equal(view.verdict, ' REQUEST_CHANGES ');
    assert.equal(view.reviewedSha, 'a'.repeat(40));
    assert.equal(view.report, savedReport);
    assert.equal(view.confirmedEvent, null);
    assert.equal(view.requestedRecommendation, action ? 'APPROVE' : null);
    assert.equal(view.requestedFindingCount, action ? 0 : null);
    assert.equal(savedReviewView(run)!.report, savedReport);
  }
});
test('a prepared receipt cannot confirm publication, a published one can', () => {
  const run = savedRun('post');
  run.reviewPublication = {
    checkedAt: 'now',
    receipt: { state: 'prepared', event: 'APPROVE' },
  } as Run['reviewPublication'];
  assert.equal(savedReviewView(run)!.confirmedEvent, null);
  run.reviewPublication!.receipt!.state = 'published';
  assert.equal(savedReviewView(run)!.confirmedEvent, 'APPROVE');
  assert.equal(savedReviewView(run)!.verdict, ' REQUEST_CHANGES ');
});
test('latest historical payload is the fallback and missing legacy values stay unknown', () => {
  const run = savedRun('dismiss');
  run.reviewResult = undefined;
  run.decisions.push({
    ...run.decisions[0],
    id: 'later',
    payload: { kind: 'review', recommendation: 'pass', reviewMd: savedReport },
  } as Run['decisions'][number]);
  assert.equal(savedReviewView(run)!.verdict, 'pass');
  assert.equal(savedReviewView(run)!.report, savedReport);
  assert.equal(savedReviewView(run)!.reviewedSha, null);
  run.decisions = [];
  assert.deepEqual(savedReviewView(run), {
    verdict: null,
    reviewedSha: null,
    report: null,
    requestedRecommendation: null,
    requestedFindingCount: null,
    confirmedEvent: null,
  });
  assert.equal(savedReviewView({ ...run, status: 'preparing' }), null);
  run.reviewResult = { recommendation: '', reviewMd: ' ', lineComments: [] };
  assert.equal(savedReviewView(run)!.report, null);
  run.decisions.push({ type: 'engine_review_posting' } as Run['decisions'][number]);
  assert.equal(savedReviewView(run), null);
  assert.equal(
    savedReviewView({ ...run, decisions: [], flowType: 'dev', reviewResult: undefined }),
    null,
  );
});
