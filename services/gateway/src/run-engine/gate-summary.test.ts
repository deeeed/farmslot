import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewStatus, RunMetrics } from '@farmslot/protocol';

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

const passingReview: ReviewStatus = {
  reviewerSessionId: 'fixture-session-' + 'pipeline-review-1',
  reviewedHeadSha: 'fixture-head',
  mode: 'cold' as const,
  id: 'pipeline-review-1',
  source: 'pipeline',
  loopNumber: 1,
  verdict: 'pass',
  unresolvedCount: 0,
  feedbackSent: false,
};

const reworkingExtraReview: ReviewStatus = {
  reviewerSessionId: 'fixture-session-' + 'review-1',
  reviewedHeadSha: 'fixture-head',
  mode: 'cold' as const,
  id: 'review-1',
  source: 'human-gate',
  loopNumber: 2,
  verdict: 'issues',
  unresolvedCount: 2,
  feedbackSent: true,
  attempts: [
    { mode: 'cold' as const, loopNumber: 1, verdict: 'issues', unresolvedCount: 2 },
    { mode: 'cold' as const, loopNumber: 2, verdict: 'issues', unresolvedCount: 2 },
  ],
};

test('buildReviewSummary projects verdicts and flags feedback-driven re-work', () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'human-gate',
        },
        reviews: [passingReview, reworkingExtraReview],
      },
    },
  });

  const summary = buildReviewSummary(run);

  // Pipeline and requested reviews share the review list.
  assert.equal(summary.reviews.length, 2);
  assert.equal(summary.review?.status, 'done');
  assert.equal(summary.review?.verdict, 'pass');
  assert.equal(summary.review?.triggeredReWork, false);

  const extra = summary.reviews.find((review) => review.source === 'human-gate')!;
  assert.equal(extra.id, 'review-1');
  assert.equal(extra.verdict, 'issues');
  assert.equal(extra.attempts, 2);
  assert.equal(extra.triggeredReWork, true); // feedbackSent + a second attempt

  assert.equal(summary.requiredReviews, 1);
  assert.equal(summary.passingReviews, 1); // pipeline passed; the requested review found issues
  assert.equal(summary.totalUnresolved, 2);
  assert.equal(summary.didAnyReviewTriggerReWork, true);
});

test('buildReviewSummary excludes findings from an older reviewed head', () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-old',
            mode: 'cold' as const,
            id: 'review-old',
            source: 'human-gate',
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
            reviewerSessionId: 'fixture-session-' + 'review-current',
            mode: 'cold' as const,
            id: 'review-current',
            source: 'human-gate',
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
    summary.reviews.map((review) => review.id),
    ['review-current'],
  );
  assert.equal(summary.passingReviews, 1);
  assert.equal(summary.totalUnresolved, 0);
});

test('buildGateSummary does not count a pass from an older prepared package', () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'human-gate',
        },
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-pass',
            mode: 'cold' as const,
            id: 'review-pass',
            source: 'human-gate',
            loopNumber: 3,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewedHeadSha: 'reviewed-head',
            reviewedReviewSubjectHash: 'reviewed-subject',
            reviewSnapshot: {
              source: 'local-git',
              baseRef: 'main',
              baseSha: 'base',
              headRef: 'feature',
              headSha: 'reviewed-head',
              diffPath: 'artifacts/reviewed.diff',
              diffHash: 'reviewed-diff',
              diffStat: { files: 5, additions: 347, deletions: 0 },
              capturedAt: '2026-08-04T00:00:00.000Z',
            },
          },
        ],
      },
    },
  });

  const summary = buildGateSummary(run, 'publication', {
    preparedPackage: {
      headSha: 'current-head',
      reviewSubjectHash: 'current-subject',
      reviewSnapshot: {
        source: 'local-git',
        baseRef: 'origin/main',
        baseSha: 'current-base',
        headRef: 'feature',
        headSha: 'current-head',
        diffHash: 'current-diff',
        diffStat: { files: 5, additions: 347, deletions: 0 },
        capturedAt: '2026-08-04T00:01:00.000Z',
      },
    },
  });

  assert.equal(summary.review.passingReviews, 0);
  assert.equal(summary.review.reviews[0]?.stale, true);
  assert.match(summary.headline ?? '', /0\/1 reviews passing/);
});

test('buildReviewSummary keeps a newer snapshot-less review failure visible', () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-pass',
            mode: 'cold' as const,
            id: 'review-pass',
            source: 'human-gate',
            loopNumber: 2,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewedHeadSha: 'current-head',
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
          },
          {
            reviewerSessionId: 'fixture-session-' + 'review-launch-failure',
            mode: 'cold' as const,
            id: 'review-launch-failure',
            source: 'human-gate',
            loopNumber: 3,
            verdict: 'failed',
            unresolvedCount: 1,
            reviewedHeadSha: 'current-head',
          },
        ],
      },
    },
  });

  const summary = buildReviewSummary(run);

  assert.deepEqual(
    summary.reviews.map((review) => review.id),
    ['review-pass', 'review-launch-failure'],
  );
  assert.equal(summary.passingReviews, 1);
  assert.equal(summary.totalUnresolved, 1);
});

test('buildReviewSummary excludes snapshot-less findings restamped to the current head', () => {
  const run = makeRun({
    engineState: {
      publishGate: {
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-restamped-issues',
            mode: 'cold' as const,
            id: 'review-restamped-issues',
            source: 'human-gate',
            loopNumber: 1,
            verdict: 'issues',
            unresolvedCount: 4,
            reviewedHeadSha: 'current-head',
          },
          {
            reviewerSessionId: 'fixture-session-' + 'review-current',
            mode: 'cold' as const,
            id: 'review-current',
            source: 'human-gate',
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
    summary.reviews.map((review) => review.id),
    ['review-current'],
  );
  assert.equal(summary.passingReviews, 1);
  assert.equal(summary.totalUnresolved, 0);
});

test('buildReviewSummary surfaces review skip reason from the pipeline step', () => {
  const run = makeRun({
    steps: [
      {
        name: 'review',
        status: 'skipped',
        outputs: { skipped: true, reason: 'interactive-lightweight-policy' },
      },
    ],
  });

  const summary = buildReviewSummary(run);
  assert.equal(summary.review?.status, 'skipped');
  assert.equal(summary.review?.reason, 'interactive-lightweight-policy');
  assert.equal(summary.noCodeReview, true);
  assert.equal(summary.reviews.length, 0);
});

test('buildReviewSummary surfaces skip reason when review is a skipped entry', () => {
  // Mirrors a real dev run: review recorded as a `skipped` entry AND a step
  // carrying the reason. The reason must surface from the step.
  const run = makeRun({
    steps: [
      {
        name: 'review',
        status: 'skipped',
        outputs: { skipped: true, reason: 'disabled-for-project' },
      },
    ],
    engineState: {
      publishGate: {
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            reviewedHeadSha: 'fixture-head',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'pipeline',
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
  assert.equal(summary.review?.status, 'skipped');
  assert.equal(summary.review?.reason, 'disabled-for-project');
  assert.equal(summary.noCodeReview, true);
  assert.equal(summary.reviews.length, 1);
});

test('a requested code review clears the skipped-pipeline warning', () => {
  const run = makeRun({
    steps: [
      {
        name: 'review',
        status: 'skipped',
        outputs: { skipped: true, reason: 'disabled-for-project' },
      },
    ],
    engineState: { publishGate: { reviews: [] } },
  });
  assert.equal(buildReviewSummary(run).review?.status, 'skipped');
  assert.equal(buildReviewSummary(run).noCodeReview, true);
  for (const verdict of ['pending', 'failed', 'cancelled', 'pass', 'issues'] as const) {
    run.engineState!.publishGate!.reviews = [
      {
        ...passingReview,
        id: 'review-1',
        source: 'human-gate',
        verdict,
      },
    ];
    assert.equal(
      buildReviewSummary(run).noCodeReview,
      ['pass', 'issues'].includes(verdict) ? undefined : true,
      verdict,
    );
  }
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

test('enrichDecisionsWithGateSummary projects a ready gate decision without mutating the original', () => {
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

  const frozen = {
    ...enriched,
    decisions: [
      {
        ...enriched.decisions[0],
        payload: {
          ...payload,
          gateSummary: { ...payload.gateSummary, headline: 'stale snapshot' },
        },
      },
    ],
  };
  const refreshedPayload = enrichDecisionsWithGateSummary(frozen).decisions[0].payload;
  assert.ok(refreshedPayload?.kind === 'ready');
  assert.notEqual(refreshedPayload.gateSummary?.headline, 'stale snapshot');

  const resolved = {
    ...frozen,
    decisions: [{ ...frozen.decisions[0], resolvedAt: '2026-04-15T01:00:00.000Z' }],
  };
  const resolvedPayload = enrichDecisionsWithGateSummary(resolved).decisions[0].payload;
  assert.ok(resolvedPayload?.kind === 'ready');
  assert.equal(resolvedPayload.gateSummary?.headline, 'stale snapshot');
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
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            reviewedHeadSha: 'fixture-head',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'human-gate',
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

test('buildGateSummary derives per-child-unit step durations beside the parent rows', () => {
  const run = makeRun({
    metrics: metrics({
      checklistTiming: {
        schemaVersion: 1,
        source: 'CHECKLIST.md',
        events: [
          { stepNumber: 1, label: 'Setup', checkedAt: '2026-04-16T00:00:00.000Z' },
          { stepNumber: 2, label: 'Review skill', checkedAt: '2026-04-16T00:05:00.000Z' },
        ],
      },
      subtasks: [
        {
          id: 'perps-review',
          parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
          source: { kind: 'skill', ref: 'skills/review.md', sha256: 'aa', renderedSha256: 'bb' },
          status: 'complete',
          durationMs: 120_000,
          completedSteps: 3,
          totalSteps: 3,
          checklistTiming: {
            schemaVersion: 1,
            source: 'subtasks/perps-review.md',
            events: [
              { stepNumber: 1, label: 'Read the diff', checkedAt: '2026-04-16T00:01:00.000Z' },
              { stepNumber: 2, label: 'Check patterns', checkedAt: '2026-04-16T00:02:00.000Z' },
              { stepNumber: 3, label: 'Write findings', checkedAt: '2026-04-16T00:03:00.000Z' },
            ],
          },
        },
        {
          // A child that registered but never marked a step contributes no row.
          id: 'evidence-pack',
          parent: { checklist: 'CHECKLIST.md', stepNumber: 3 },
          source: { kind: 'inline', sha256: 'cc', renderedSha256: 'dd' },
          status: 'running',
          durationMs: null,
          completedSteps: 0,
          totalSteps: 2,
        },
      ],
    }),
  });

  const summary = buildGateSummary(run, 'publication');
  assert.ok(summary.checklist);
  assert.equal(summary.checklist.subtasks?.length, 1);
  const child = summary.checklist.subtasks?.[0];
  assert.equal(child?.id, 'perps-review');
  assert.deepEqual(child?.parent, { checklist: 'CHECKLIST.md', stepNumber: 2 });
  assert.equal(child?.perStepMs.length, 3);
  // Same derivation as the parent rows: first mark 0, then deltas.
  assert.equal(child?.perStepMs[0].durationMs, 0);
  assert.equal(child?.perStepMs[1].durationMs, 60_000);
  assert.equal(child?.perStepMs[2].label, 'Write findings');
});

test('buildGateSummary omits the subtasks field when a run registered no child unit', () => {
  const run = makeRun({
    metrics: metrics({
      checklistTiming: {
        schemaVersion: 1,
        events: [{ stepNumber: 1, label: 'Setup', checkedAt: '2026-04-16T00:00:00.000Z' }],
      },
    }),
  });
  assert.equal(buildGateSummary(run, 'publication').checklist?.subtasks, undefined);
});

test('retrospective distinguishes missing turns from observed zero and records review skips', () => {
  const absent = makeRun({
    metrics: metrics({ outcome: 'success' }),
    steps: [
      {
        name: 'review',
        status: 'done',
        outputs: { skipped: true, reason: 'disabled-for-project' },
      },
    ],
  });
  const summary = buildGateSummary(absent, 'review');
  assert.equal(summary.worker.turns, null);
  assert.match(summary.headline ?? '', /turns not captured/);
  assert.match(summary.review.summaryText ?? '', /disabled-for-project/);
  assert.doesNotMatch(summary.review.summaryText ?? '', /no reviews/);
  assert.match(
    buildGateSummary(makeRun({ metrics: metrics({ sessionTurns: 0 }) }), 'review').headline ?? '',
    /in 0 turns/,
  );
});

test('retrospective read projection refreshes stale outcome and zero-turn snapshot', () => {
  const run = makeRun({
    metrics: metrics({ outcome: 'success', sessionTurns: 7 }),
    decisions: [
      {
        id: 'retro',
        type: 'retrospective',
        title: 'Review',
        description: 'Recorded run review',
        createdAt: '2026-10-10',
        actions: [],
        payload: {
          kind: 'retrospective',
          outcome: 'partial',
          whatThisIs: 'Review',
          actionEffects: [],
        },
      },
    ],
  });
  const projected = enrichDecisionsWithGateSummary(run);
  const payload = projected.decisions[0].payload;
  assert.equal(payload?.kind, 'retrospective');
  if (payload?.kind !== 'retrospective') throw new Error('missing retrospective');
  assert.equal(payload.outcome, 'success');
  assert.equal(payload.gateSummary?.worker.turns, 7);
  assert.equal(
    run.decisions[0].payload?.kind === 'retrospective' && run.decisions[0].payload.outcome,
    'partial',
  );
});

test('a later reviewer failure cannot replace the captured primary worker outcome at the gate', () => {
  const run = makeRun({
    metrics: metrics({ outcome: 'failure', disposition: 'fixed', sessionTurns: 483 }),
    steps: [{ name: 'monitor', status: 'done' }],
    engineState: { publishGate: { reviews: [passingReview] } },
  });
  const monitor = run.steps.find((step) => step.name === 'monitor')!;
  monitor.status = 'done';
  for (const outcome of ['success', 'failure', 'partial', 'cancelled'] as const) {
    monitor.outputs = { workerSignal: { status: 'complete', outcome } };
    const summary = buildGateSummary(run, 'publication');
    assert.equal(summary.worker.outcome, outcome);
    assert.ok(summary.headline?.startsWith(`Worker ${outcome} in 483 turns`));
    assert.equal(run.metrics.outcome, 'failure', 'Keep the separate pipeline outcome unchanged');
  }
  for (const outputs of [undefined, { workerSignal: { outcome: 'unknown' } }]) {
    monitor.outputs = outputs;
    assert.equal(buildGateSummary(run, 'publication').worker.outcome, 'failure');
  }
});
