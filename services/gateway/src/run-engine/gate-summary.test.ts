import assert from 'node:assert/strict';
import test from 'node:test';

import type { IndependentReviewStatus, RunMetrics } from '@farmslot/protocol';

import {
  aggregateFamilyChainedLoops,
  buildGateSummary,
  buildReviewSummary,
  buildTokenSummary,
  enrichDecisionsWithGateSummary,
} from './gate-summary.js';
import { makeRun } from './test-fixtures.js';

function metrics(overrides: Partial<RunMetrics> = {}): RunMetrics {
  return {
    nudgeCount: 0,
    model: 'opus',
    runner: 'claude',
    runnerSessionId: null,
    runnerSessionPath: null,
    ...overrides,
  };
}

const passingSelfReview: IndependentReviewStatus = {
  id: 'self-review-1',
  source: 'self-review',
  crossRunner: false,
  loopNumber: 1,
  verdict: 'pass',
  unresolvedCount: 0,
  feedbackSent: false,
};

const reworkingExtraReview: IndependentReviewStatus = {
  id: 'independent-review-1',
  source: 'human-gate',
  crossRunner: true,
  loopNumber: 2,
  verdict: 'issues',
  unresolvedCount: 2,
  feedbackSent: true,
  attempts: [
    { loopNumber: 1, verdict: 'issues', unresolvedCount: 2 },
    { loopNumber: 2, verdict: 'issues', unresolvedCount: 2 },
  ],
};

test('buildReviewSummary projects verdicts and flags feedback-driven re-work', () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: true,
          extraLoopsRequested: 0,
          requestedBy: 'human-gate',
        },
        independentReviews: [passingSelfReview, reworkingExtraReview],
      },
    },
  });

  const summary = buildReviewSummary(run);

  // Self-review split out of the independent list.
  assert.equal(summary.independentReviews.length, 1);
  assert.equal(summary.selfReview?.status, 'done');
  assert.equal(summary.selfReview?.verdict, 'pass');
  assert.equal(summary.selfReview?.triggeredReWork, false);

  const extra = summary.independentReviews[0];
  assert.equal(extra.id, 'independent-review-1');
  assert.equal(extra.verdict, 'issues');
  assert.equal(extra.attempts, 2);
  assert.equal(extra.triggeredReWork, true); // feedbackSent + a second attempt

  assert.equal(summary.requiredReviews, 1);
  assert.equal(summary.passingReviews, 0); // the one independent review found issues
  assert.equal(summary.totalUnresolved, 2);
  assert.equal(summary.didAnyReviewTriggerReWork, true);
});

test('buildReviewSummary excludes findings from an older reviewed head', () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-old',
            source: 'human-gate',
            crossRunner: true,
            loopNumber: 2,
            verdict: 'issues',
            unresolvedCount: 7,
            reviewSnapshot: {
              source: 'local-git',
              baseRef: 'main',
              baseSha: 'base',
              headRef: 'feature',
              headSha: 'old-head',
              diffPath: 'artifacts/old.diff',
              diffHash: 'old-diff',
              diffStat: { files: 1, additions: 1, deletions: 0 },
              capturedAt: '2026-07-30T01:00:00.000Z',
            },
            // Package refreshes may restamp this compatibility field; the
            // immutable review snapshot remains the authority for code freshness.
            reviewedHeadSha: 'current-head',
          },
          {
            id: 'independent-review-current',
            source: 'human-gate',
            crossRunner: true,
            loopNumber: 3,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewSnapshot: {
              source: 'local-git',
              baseRef: 'main',
              baseSha: 'base',
              headRef: 'feature',
              headSha: 'current-head',
              diffPath: 'artifacts/current.diff',
              diffHash: 'current-diff',
              diffStat: { files: 1, additions: 2, deletions: 0 },
              capturedAt: '2026-07-30T02:00:00.000Z',
            },
            reviewedHeadSha: 'current-head',
          },
        ],
      },
    },
  });

  const summary = buildReviewSummary(run);

  assert.deepEqual(
    summary.independentReviews.map((review) => review.id),
    ['independent-review-current'],
  );
  assert.equal(summary.passingReviews, 1);
  assert.equal(summary.totalUnresolved, 0);
});

test('buildReviewSummary excludes snapshot-less findings restamped to the current head', () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-restamped-issues',
            source: 'human-gate',
            crossRunner: false,
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 4,
            reviewedHeadSha: 'current-head',
          },
          {
            id: 'independent-review-current',
            source: 'human-gate',
            crossRunner: false,
            loopNumber: 2,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewSnapshot: {
              source: 'local-git',
              baseRef: 'main',
              baseSha: 'base',
              headRef: 'feature',
              headSha: 'current-head',
              diffPath: 'artifacts/current.diff',
              diffHash: 'current-diff',
              diffStat: { files: 1, additions: 2, deletions: 0 },
              capturedAt: '2026-08-03T22:00:00.000Z',
            },
            reviewedHeadSha: 'current-head',
          },
        ],
      },
    },
  });

  const summary = buildReviewSummary(run);

  assert.deepEqual(
    summary.independentReviews.map((review) => review.id),
    ['independent-review-current'],
  );
  assert.equal(summary.passingReviews, 1);
  assert.equal(summary.totalUnresolved, 0);
});

test('buildReviewSummary surfaces self-review skip reason from the pipeline step', () => {
  const run = makeRun({
    steps: [
      {
        name: 'self-review',
        status: 'skipped',
        outputs: { skipped: true, reason: 'interactive-lightweight-policy' },
      },
    ],
  });

  const summary = buildReviewSummary(run);
  assert.equal(summary.selfReview?.status, 'skipped');
  assert.equal(summary.selfReview?.reason, 'interactive-lightweight-policy');
  assert.equal(summary.independentReviews.length, 0);
});

test('buildReviewSummary surfaces skip reason when self-review is a skipped entry', () => {
  // Mirrors a real dev run: self-review recorded as a `skipped` entry AND a step
  // carrying the reason. The reason must surface from the step.
  const run = makeRun({
    steps: [
      {
        name: 'self-review',
        status: 'skipped',
        outputs: { skipped: true, reason: 'disabled-for-project' },
      },
    ],
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'self-review-1',
            source: 'self-review',
            crossRunner: false,
            loopNumber: 1,
            verdict: 'skipped',
            unresolvedCount: 0,
            feedbackSent: false,
          },
        ],
      },
    },
  });

  const summary = buildReviewSummary(run);
  assert.equal(summary.selfReview?.status, 'skipped');
  assert.equal(summary.selfReview?.reason, 'disabled-for-project');
  assert.equal(summary.independentReviews.length, 0);
});

test('aggregateFamilyChainedLoops rolls up pr-complete/update-branch loops only', () => {
  const root = makeRun({
    id: 'root',
    familyId: 'fam',
    flowType: 'dev',
    metrics: metrics({ sessionTotalTokens: 1000 }),
  });
  const fixLoop = makeRun({
    id: 'child',
    familyId: 'fam',
    flowType: 'pr-complete',
    createdAt: '2026-04-16T00:00:00.000Z',
    metrics: metrics({
      model: 'opus',
      actualModel: 'claude-opus-4-8',
      runnerSessionPath: '/sessions/child.jsonl',
      sessionInputTokens: 100,
      sessionOutputTokens: 400,
      sessionTotalTokens: 500,
    }),
  });
  const unrelatedReview = makeRun({
    id: 'sib',
    familyId: 'fam',
    flowType: 'review-pr',
    metrics: metrics({ sessionTotalTokens: 999 }),
  });

  const loops = aggregateFamilyChainedLoops(root, [root, fixLoop, unrelatedReview]);
  assert.ok(loops);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].runId, 'child');
  assert.equal(loops[0].flowType, 'pr-complete');
  assert.equal(loops[0].tokens.total, 500);
  assert.equal(loops[0].perTurnSessionPath, '/sessions/child.jsonl');

  // No qualifying loops → undefined (keeps the optional field absent).
  assert.equal(aggregateFamilyChainedLoops(root, [root, unrelatedReview]), undefined);
});

test('enrichDecisionsWithGateSummary lazily backfills a ready gate decision without mutating the original', () => {
  const run = makeRun({
    metrics: metrics({ sessionTotalTokens: 1000, sessionTurns: 10 }),
    decisions: [
      {
        id: 'engine_human_gate-1',
        type: 'engine_human_gate',
        title: 'Human gate',
        description: '',
        actions: [],
        createdAt: '2026-04-15T00:00:00.000Z',
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: null,
          diffStat: { files: 0, additions: 0, deletions: 0 },
          workerReport: '',
          branch: 'x',
        },
      },
    ],
  });

  const enriched = enrichDecisionsWithGateSummary(run);
  const payload = enriched.decisions[0].payload;
  assert.ok(payload?.kind === 'ready'); // narrows to ReadyGatePayload
  assert.ok(payload.gateSummary);
  assert.equal(payload.gateSummary.kind, 'publication');
  // Original is untouched — enrichment returns a copy.
  const original = run.decisions[0].payload;
  assert.ok(original?.kind === 'ready');
  assert.equal(original.gateSummary, undefined);
});

test('enrichDecisionsWithGateSummary backfills a retrospective decision with the review kind', () => {
  const run = makeRun({
    metrics: metrics({ sessionTotalTokens: 500, sessionTurns: 5 }),
    decisions: [
      {
        id: 'retrospective-1',
        type: 'retrospective',
        title: 'Retrospective',
        description: '',
        actions: [],
        createdAt: '2026-04-15T00:00:00.000Z',
        payload: {
          kind: 'retrospective',
          outcome: 'success',
          whatThisIs: 'test',
          actionEffects: [],
        },
      },
    ],
  });

  const enriched = enrichDecisionsWithGateSummary(run);
  const payload = enriched.decisions[0].payload;
  assert.ok(payload?.kind === 'retrospective'); // narrows to RetrospectivePayload
  assert.ok(payload.gateSummary);
  assert.equal(payload.gateSummary.kind, 'review');
  assert.equal(payload.gateSummary.gatePolicy, undefined); // review backfill omits gatePolicy
});

// Family-loop rollup is unit-tested directly in `aggregateFamilyChainedLoops` above;
// this case exercises the main-worker projection with an empty store (no loops).
test('buildTokenSummary projects main-worker tokens from run metrics', () => {
  const run = makeRun({
    id: 'solo',
    familyId: 'solo',
    flowType: 'dev',
    metrics: metrics({
      actualModel: 'claude-opus-4-8',
      runnerSessionPath: '/sessions/solo.jsonl',
      sessionInputTokens: 51819,
      sessionOutputTokens: 19936,
      sessionCacheRead: 3468445,
      sessionCacheCreation: 182174,
      sessionTotalTokens: 3722374,
      sessionTurns: 55,
    }),
  });

  const tokens = buildTokenSummary(run);
  assert.equal(tokens.mainWorker.model, 'claude-opus-4-8');
  assert.equal(tokens.mainWorker.total, 3722374);
  assert.equal(tokens.mainWorker.turns, 55);
  assert.equal(tokens.familyTotalTokens, 3722374); // no reviews, no family loops in store
  assert.equal(tokens.perTurnDetailsAvailable, true);
  assert.deepEqual(tokens.runnerSessionPaths, ['/sessions/solo.jsonl']);
});

test('buildTokenSummary rolls up tokens by model, reads the review usage split, and reports re-work', () => {
  const run = makeRun({
    id: 'rollup',
    familyId: 'rollup',
    flowType: 'dev',
    metrics: metrics({
      actualModel: 'claude-opus-4-8',
      nudgeCount: 3,
      sessionInputTokens: 1000,
      sessionOutputTokens: 200,
      sessionCacheRead: 50,
      sessionCacheCreation: 10,
      sessionTotalTokens: 1260,
      sessionTurns: 12,
    }),
    engineState: {
      publishGate: {
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'human-gate',
            crossRunner: true,
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            feedbackSent: false,
            usage: {
              actualModel: 'claude-opus-4-8',
              inputTokens: 300,
              outputTokens: 100,
              cacheRead: 20,
              cacheCreation: 5,
              totalTokens: 425,
              measuredAt: '2026-04-16T00:00:00.000Z',
              source: 'runner-transcript',
            },
          },
        ],
      },
    },
  });

  const tokens = buildTokenSummary(run);

  // Review usage split is read in full (not just total).
  assert.equal(tokens.reviews[0].total, 425);
  assert.equal(tokens.reviews[0].input, 300);
  assert.equal(tokens.reviews[0].cacheRead, 20);

  // Both worker + review are claude-opus-4-8 → one rolled-up model bucket.
  assert.equal(tokens.byModel.length, 1);
  const opus = tokens.byModel[0];
  assert.equal(opus.model, 'claude-opus-4-8');
  assert.equal(opus.total, 1260 + 425);
  assert.equal(opus.input, 1000 + 300);
  assert.equal(opus.turns, 12); // worker turns; reviews contribute 0

  // No family loops, but 3 nudges → re-work surfaced from nudges alone.
  assert.ok(tokens.reWork);
  assert.equal(tokens.reWork.tokens, 0);
  assert.equal(tokens.reWork.loops, 0);
  assert.equal(tokens.reWork.nudgeCount, 3);
});

test('buildGateSummary derives per-step checklist durations from persisted timing', () => {
  const run = makeRun({
    metrics: metrics({
      sessionTotalTokens: 100,
      sessionTurns: 3,
      checklistTiming: {
        schemaVersion: 1,
        source: 'TASK.md',
        events: [
          { stepNumber: 1, label: 'Setup', checkedAt: '2026-04-16T00:00:00.000Z' },
          { stepNumber: 2, label: 'Implement', checkedAt: '2026-04-16T00:01:30.000Z' },
          { stepNumber: 3, label: 'Verify', checkedAt: '2026-04-16T00:02:00.000Z' },
        ],
      },
    }),
  });

  const summary = buildGateSummary(run, 'publication');
  assert.ok(summary.checklist);
  assert.equal(summary.checklist.perStepMs.length, 3);
  // First step has no prior mark → 0; subsequent steps are deltas.
  assert.equal(summary.checklist.perStepMs[0].durationMs, 0);
  assert.equal(summary.checklist.perStepMs[1].durationMs, 90_000);
  assert.equal(summary.checklist.perStepMs[2].durationMs, 30_000);
  assert.equal(summary.checklist.perStepMs[1].label, 'Implement');
});
