import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type GateSummary,
  type ReadyGatePayload,
  type ReviewStatus,
  type Run,
  runListRow,
  trimRunForList,
} from '@farmslot/protocol';

import {
  activePublicationReviewLabel,
  classifyReviewFreshness,
  compactHumanGateLabel,
  fixDeltaAbsenceReason,
  formatTokenCount,
  gateSummaryDisplay,
  hasMeaningfulReviewFixDelta,
  publishEvidenceDisplayRows,
  readyReviewBlockingDisplayReason,
  reviewAttemptLabel,
  reviewHasPendingContinuationPhases,
  reviewSegmentLabel,
  summarizeReviewCounts,
} from './review-gate-display.js';

function payload(review: Partial<ReviewStatus>): ReadyGatePayload {
  return {
    kind: 'ready',
    prNumber: null,
    repo: null,
    diffStat: { files: 1, additions: 1, deletions: 0 },
    workerReport: '',
    branch: 'feature/demo',
    prPackage: {
      id: 'pkg-1',
      packageHash: 'hash',
      artifactPath: 'artifacts/pr-package.json',
      branch: 'feature/demo',
      headSha: 'head-new-1234567890',
      reviewSubjectHash: 'subject-new-1234567890',
      diffStat: { files: 1, additions: 1, deletions: 0 },
      draftTitle: 'fix(ui): demo',
      draftBody: 'body',
      evidenceManifest: [
        { path: 'artifacts/before.png', purpose: 'screenshot-before' },
        { path: 'artifacts/after.png', purpose: 'screenshot-after' },
      ],
      selectedEvidenceKeys: ['artifacts/before.png'],
      reviewArtifactIds: [],
      gatePolicy: { owner: 'human', publishAuthority: 'human', reason: 'demo' },
      reviewPolicy: {
        minimumReviews: 1,

        requestedBy: 'dispatch',
      },
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      createdAt: '2026-05-18T00:00:00.000Z',
    },
    reviews: [
      {
        id: 'review-1',
        reviewerSessionId: 'review-session-1',

        loopNumber: 1,
        mode: 'cold',
        verdict: 'pass',
        unresolvedCount: 0,
        reviewedHeadSha: 'head-new-1234567890',
        reviewedReviewSubjectHash: 'subject-new-1234567890',
        reviewSnapshot: {
          source: 'local-git',
          headSha: 'head-new-1234567890',
          capturedAt: '2026-05-18T00:00:00.000Z',
        },
        ...review,
      },
    ],
  };
}

test('classifyReviewFreshness explains stale head, stale subject, and unavailable snapshot separately', () => {
  assert.equal(
    classifyReviewFreshness(
      payload({ reviewedHeadSha: 'head-old' }).reviews![0],
      payload({ reviewedHeadSha: 'head-old' }),
    ).reason,
    'reviewed-old-head',
  );
  assert.match(
    readyReviewBlockingDisplayReason(payload({ reviewedHeadSha: 'head-old' })),
    /Reviewed head-old; package HEAD is head-new-123/,
  );

  const staleSubject = payload({ reviewedReviewSubjectHash: 'subject-old' });
  assert.equal(
    classifyReviewFreshness(staleSubject.reviews![0], staleSubject).reason,
    'review-subject-changed',
  );
  assert.match(readyReviewBlockingDisplayReason(staleSubject), /Reviewed subject subject-old/);

  const unavailable = payload({
    reviewedHeadSha: undefined,
    reviewSnapshot: {
      source: 'unavailable',
      capturedAt: '2026-05-18T00:00:00.000Z',
      missingReason: 'no-diff',
    },
  });
  assert.equal(
    classifyReviewFreshness(unavailable.reviews![0], unavailable).reason,
    'review-snapshot-unavailable',
  );
  assert.match(readyReviewBlockingDisplayReason(unavailable), /snapshot unavailable/);
});

test('summarizeReviewCounts separates required, fresh, stale, attempts and unresolved counts', () => {
  const fixture = payload({
    attempts: [
      { loopNumber: 1, mode: 'cold', verdict: 'issues', unresolvedCount: 1 },
      { loopNumber: 2, mode: 'cold', verdict: 'pass', unresolvedCount: 0 },
    ],
  });
  fixture.prPackage!.reviewPolicy = {
    minimumReviews: 1,

    requestedBy: 'human-gate',
  };
  fixture.reviews = [
    fixture.reviews![0],
    {
      ...fixture.reviews![0],
      id: 'review-stale',

      reviewedHeadSha: 'old-head',
      reviewSnapshot: {
        source: 'local-git',
        headSha: 'old-head',
        capturedAt: '2026-05-18T00:00:00.000Z',
      },
      attempts: undefined,
    },
  ];

  const summary = summarizeReviewCounts(fixture);
  assert.equal(summary.requiredReviews, 1);
  assert.equal(summary.freshPassingReviews, 1);
  assert.equal(summary.staleIgnoredReviews, 1);
  assert.equal(summary.totalAttempts, 3);
});

test('publishEvidenceDisplayRows exposes included, excluded and dropped-after-refresh evidence', () => {
  const rows = publishEvidenceDisplayRows(
    payload({}),
    ['artifacts/before.png', 'artifacts/dropped.png'],
    [
      { path: 'artifacts/before.png', purpose: 'screenshot-before' },
      { path: 'artifacts/after.png', purpose: 'screenshot-after' },
    ],
  );

  assert.deepEqual(
    rows.map((row) => [row.path, row.included, row.dropped]),
    [
      ['artifacts/before.png', true, false],
      ['artifacts/after.png', false, false],
      ['artifacts/dropped.png', false, true],
    ],
  );
});

test('review labels use source without runner classification', () => {
  const requested = payload({ source: 'human-gate' }).reviews![0];
  assert.equal(reviewAttemptLabel(requested, 1, 2), 'Review round 2');
  assert.equal(reviewSegmentLabel(requested, 1), 'Review (requested) 1');
});

test('pending continuation phases cover undelivered exhausted findings', () => {
  const attempt = { unresolvedCount: 2 };
  // Exhausted / recovery-restored rows record feedbackSent: false because the
  // final findings never reached the worker — they still owe fix + re-review.
  assert.equal(
    reviewHasPendingContinuationPhases({ recoveryContinuationPending: true }, attempt),
    true,
  );
  assert.equal(
    reviewHasPendingContinuationPhases({ recoveryContinuationPending: false }, attempt),
    false,
  );
  assert.equal(
    reviewHasPendingContinuationPhases({ recoveryContinuationPending: true }, undefined),
    false,
  );
  assert.equal(
    reviewHasPendingContinuationPhases(
      { recoveryContinuationPending: true },
      {
        unresolvedCount: 0,
      },
    ),
    false,
  );
});

test('fixDeltaAbsenceReason explains audit-only and unavailable fix ranges', () => {
  const auditOnly = payload({ verdict: 'issues', unresolvedCount: 1, feedbackSent: false })
    .reviews![0];
  assert.match(fixDeltaAbsenceReason(auditOnly, undefined), /audit-only review/);

  const unavailable = payload({
    fixDelta: {
      source: 'unavailable',
      capturedAt: '2026-05-18T00:00:00.000Z',
      missingReason: 'fix-base-unavailable',
    },
  }).reviews![0];
  assert.match(fixDeltaAbsenceReason(unavailable, undefined), /fix-base-unavailable/);

  const unchanged = payload({
    fixDelta: {
      source: 'local-git',
      capturedAt: '2026-05-18T00:00:00.000Z',
      baseSha: 'same-sha',
      headSha: 'same-sha',
    },
  }).reviews![0];
  assert.equal(hasMeaningfulReviewFixDelta(unchanged.fixDelta), false);
  assert.match(fixDeltaAbsenceReason(unchanged, undefined), /No tracked worker change/);
});

test('fix retries preserve one session count and cannot certify old heads', () => {
  const fixture = payload({
    attempts: [
      { loopNumber: 1, mode: 'cold', verdict: 'issues', unresolvedCount: 1 },
      { loopNumber: 2, mode: 'warm', verdict: 'pass', unresolvedCount: 0 },
    ],
  });
  fixture.reviews!.push({ ...fixture.reviews![0], id: 'same-session-recheck' });
  assert.equal(summarizeReviewCounts(fixture).trustedPassingReviews, 1);
  fixture.reviews!.forEach((review) => {
    review.reviewedHeadSha = 'old-head';
  });
  const summary = summarizeReviewCounts(fixture);
  assert.equal(summary.trustedPassingReviews, 0);
  assert.equal(summary.staleIgnoredReviews, 2);
});

test('missing session provenance cannot count a passing result', () => {
  const fixture = payload({ reviewerSessionId: undefined });
  assert.equal(summarizeReviewCounts(fixture).trustedPassingReviews, 0);
  assert.equal(
    classifyReviewFreshness(fixture.reviews![0], fixture).reason,
    'review-session-missing',
  );
});

test('classifyReviewFreshness treats missing package review subject as stale', () => {
  const fixture = payload({});
  delete fixture.prPackage!.reviewSubjectHash;

  const freshness = classifyReviewFreshness(fixture.reviews![0], fixture);
  assert.equal(freshness.reason, 'package-review-subject-missing');
  assert.match(readyReviewBlockingDisplayReason(fixture), /review-subject hash/);
});

test('review labels preserve review source', () => {
  const review = payload({ source: 'pipeline' }).reviews![0];
  assert.equal(reviewAttemptLabel(review, 0, 1), 'Review round 1');
  assert.equal(reviewSegmentLabel(review, 2), 'Review 2');
});

test('compact human-gate labels prioritize the active review loop', () => {
  const activeFix = {
    agentContexts: [
      {
        id: 'review-fix',
        role: 'review-fix' as const,
        label: 'Review fix',
        status: 'working' as const,
        slotId: 'slot-1',
        runId: 'run-1',
      },
    ],
    decisions: [],
  };
  assert.equal(activePublicationReviewLabel(activeFix), 'Review fix');
  assert.equal(compactHumanGateLabel(activeFix), 'review fix');

  assert.equal(
    compactHumanGateLabel({
      agentContexts: [],
      decisions: [],
      engineState: {
        publishGate: {
          reviewSequence: [{ runner: 'codex', model: null, effort: null, mode: 'cold' }],
        },
      },
    }),
    'review',
  );

  assert.equal(
    compactHumanGateLabel({
      agentContexts: [],
      decisions: [],
      engineState: {
        publishGate: {
          reviewSequence: [{ runner: 'codex', model: null, effort: null, mode: 'cold' }],
          reviewLaunchRejection: {
            code: 'PUBLICATION_REVIEW_LAUNCH_REJECTED',
            message: 'The slot worktree is dirty.',
            userAction: 'Commit the validated fixes, then request review again.',
            rejectedAt: '2026-08-04T00:00:00.000Z',
          },
        },
      },
    }),
    'review launch paused',
  );
});

test('compact human-gate labels distinguish publish-ready from review-blocked', () => {
  assert.equal(
    compactHumanGateLabel({
      decisions: [
        {
          id: 'gate-1',
          type: 'engine_human_gate',
          title: 'Publication',
          description: '',
          actions: [{ id: 'approve-publish', label: 'Approve Publish', style: 'primary' }],
          createdAt: '2026-07-30T00:00:00.000Z',
        },
      ],
    }),
    'publish ready',
  );

  assert.equal(
    compactHumanGateLabel({
      decisions: [],
      engineState: {
        publishGate: {
          reviews: [
            {
              id: 'independent-review-1',
              source: 'human-gate',

              loopNumber: 1,
              mode: 'cold',
              verdict: 'issues',
              unresolvedCount: 2,
            },
          ],
        },
      },
    }),
    'review blocked',
  );

  assert.equal(
    compactHumanGateLabel({
      decisions: [],
      engineState: {
        publishGate: {
          reviews: [
            {
              id: 'independent-review-3',
              source: 'human-gate',

              loopNumber: 3,
              mode: 'cold',
              verdict: 'issues',
              unresolvedCount: 6,
              feedbackSent: false,
              recoveryContinuationPending: true,
              retryCount: 3,
              maxRetries: 3,
              maxRetriesExhausted: true,
            },
          ],
        },
      },
    }),
    'review retries exhausted',
  );
});

test('readyReviewBlockingDisplayReason names the retry cap instead of the first finding file', () => {
  const fixture = payload({
    source: 'human-gate',
    verdict: 'issues',
    unresolvedCount: 6,
    retryCount: 3,
    maxRetries: 3,
    maxRetriesExhausted: true,
    issues: [{ file: 'src/fee.ts', line: 10, description: 'blend is wrong' }],
  });
  assert.match(readyReviewBlockingDisplayReason(fixture), /stopped after 3\/3 fix attempts/);
  assert.doesNotMatch(readyReviewBlockingDisplayReason(fixture), /src\/fee.ts/);
});

test('readyReviewBlockingDisplayReason cites stale reviews even when fresh quorum is satisfied', () => {
  const fixture = payload({});
  fixture.prPackage!.reviewPolicy = {
    minimumReviews: 1,

    requestedBy: 'dispatch',
  };
  fixture.reviews = [
    fixture.reviews![0],
    {
      ...fixture.reviews![0],
      id: 'stale-extra-review',
      reviewedHeadSha: 'old-head',
      reviewSnapshot: {
        source: 'local-git',
        headSha: 'old-head',
        capturedAt: '2026-05-18T00:00:00.000Z',
      },
    },
  ];

  const summary = summarizeReviewCounts(fixture);
  assert.equal(summary.trustedPassingReviews, 1);
  assert.equal(summary.staleIgnoredReviews, 1);
  assert.match(readyReviewBlockingDisplayReason(fixture), /stale review ignored/i);
});

test('formatTokenCount renders compact units and safe fallbacks', () => {
  // Non-positive / non-finite fall back to '0'.
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(-1), '0');
  assert.equal(formatTokenCount(NaN), '0');
  assert.equal(formatTokenCount(Infinity), '0');
  // Unit boundaries.
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1.0k');
  assert.equal(formatTokenCount(51819), '51.8k');
  assert.equal(formatTokenCount(999_999), '1000.0k');
  assert.equal(formatTokenCount(1_000_000), '1.00M');
  assert.equal(formatTokenCount(3_722_374), '3.72M');
});

function gateSummaryWithChecklist(checklist: GateSummary['checklist']): GateSummary {
  return {
    kind: 'publication',
    flowType: 'dev',
    worker: { model: 'claude-opus-5', turns: 12 },
    review: {
      reviews: [],
      requiredReviews: 0,
      passingReviews: 0,
      totalUnresolved: 0,
      didAnyReviewTriggerReWork: false,
      summaryText: '',
    },
    tokens: {
      mainWorker: {
        model: 'claude-opus-5',
        input: 90,
        output: 10,
        cacheRead: 0,
        cacheCreation: 0,
        total: 100,
        turns: 12,
      },
      reviews: [],
      byModel: [],
      familyTotalTokens: 100,
      perTurnDetailsAvailable: false,
    },
    checklist,
    capturedAt: '2026-01-01T00:00:00Z',
  };
}

test('checklist timing nests a child unit under the step it hangs off', () => {
  const display = gateSummaryDisplay(
    gateSummaryWithChecklist({
      events: [],
      perStepMs: [
        { stepNumber: 1, label: 'Reproduce', durationMs: 5000 },
        { stepNumber: 2, label: 'Review the diff', durationMs: 120000 },
      ],
      subtasks: [
        {
          id: 'perps-review',
          parent: { checklist: 'CHECKLIST.md', stepNumber: 2 },
          source: {
            kind: 'skill',
            ref: '.agents/skills/mms-perps-review-pr/skill.md',
            sha256: 'a',
            renderedSha256: 'b',
          },
          perStepMs: [
            { stepNumber: 1, label: 'Read the diff', durationMs: 30000 },
            { stepNumber: 2, label: 'Run the recipe', durationMs: 60000 },
          ],
        },
      ],
    }),
  );
  assert.equal(display.checklist.length, 2);
  assert.equal(display.checklist[0].subtasks, undefined);
  const parent = display.checklist[1];
  assert.equal(parent.label, 'Review the diff');
  assert.equal(parent.duration, '2.0m');
  assert.equal(parent.subtasks?.length, 1);
  assert.equal(parent.subtasks?.[0].id, 'perps-review');
  assert.equal(parent.subtasks?.[0].title, 'skill.md');
  assert.match(
    parent.subtasks?.[0].titleTooltip ?? '',
    /perps-review · skill · \.agents\/skills\//,
  );
  assert.deepEqual(
    parent.subtasks?.[0].rows.map((row) => `${row.label} ${row.duration}`),
    ['Read the diff 30.0s', 'Run the recipe 1.0m'],
  );
});

test('a child whose parent step never got ticked still gets a row', () => {
  const display = gateSummaryDisplay(
    gateSummaryWithChecklist({
      events: [],
      perStepMs: [{ stepNumber: 1, label: 'Reproduce', durationMs: 5000 }],
      subtasks: [
        {
          id: 'ci-triage',
          parent: { checklist: 'CHECKLIST.md', stepNumber: 3 },
          perStepMs: [{ stepNumber: 1, label: 'Read the failing job', durationMs: 9000 }],
        },
      ],
    }),
  );
  assert.equal(display.checklist.length, 2);
  const orphan = display.checklist[1];
  assert.equal(orphan.stepNumber, 3);
  assert.equal(orphan.label, 'CHECKLIST.md step 3');
  assert.equal(orphan.duration, '\u2014');
  assert.equal(orphan.subtasks?.[0].id, 'ci-triage');
  assert.equal(orphan.subtasks?.[0].title, 'inline', 'a unit with no ref reads as inline');
  assert.equal(orphan.subtasks?.[0].titleTooltip, 'ci-triage · inline text');
});

test('a run with no child units keeps the plain parent rows', () => {
  const display = gateSummaryDisplay(
    gateSummaryWithChecklist({
      events: [],
      perStepMs: [{ stepNumber: 1, label: 'Reproduce', durationMs: 5000 }],
    }),
  );
  assert.deepEqual(display.checklist, [{ stepNumber: 1, label: 'Reproduce', duration: '5.0s' }]);
});

// Run 7721a02b (TAT-4006): fixing is no longer offered once the review rounds are spent.
test('a not-ready gate shows the reason a person can act on', () => {
  const gated: ReadyGatePayload = {
    ...payload({ verdict: 'issues', unresolvedCount: 4 }),
    gateReadiness: {
      state: 'not-ready',
      identity: { runId: 'run', generation: 8 },
      reasons: [
        {
          code: 'review-fix-required',
          prerequisite: 'review',
          message: 'Review found 4 issues. Fix and pass review before publishing.',
          actionId: 'continue-review-fix',
        },
        {
          code: 'review-result-required',
          prerequisite: 'review',
          message: 'Required current-head reviews need valid structured result artifacts.',
          actionId: 'request-review',
        },
      ],
    },
    reviewRoundBudget: {
      used: 7,
      limit: 7,
      remaining: 0,
      label: 'Review rounds 7/7',
      noVerdict: 0,
      noVerdictLimit: 3,
    },
  };
  assert.equal(
    readyReviewBlockingDisplayReason(gated, [{ id: 'hold' }, { id: 'request-review' }]),
    'Review rounds spent: 4 issues open',
  );
  assert.equal(
    readyReviewBlockingDisplayReason(gated, [{ id: 'continue-review-fix' }, { id: 'hold' }]),
    'Review found 4 issues. Fix and pass review before publishing.',
  );
});

test('gate display shows implementation and per-round dollars and preserves local unpriced status', () => {
  const summary = gateSummaryWithChecklist(undefined);
  summary.tokens.mainWorker.costUsd = 0.25;
  summary.tokens.familyCostUsd = 0.375;
  summary.tokens.reviewRounds = [
    { id: 'review-fixture', model: 'litellm/reviewer', roundNumber: 1, total: 20, costUsd: 0.125 },
    {
      id: 'local-fixture',
      model: 'ollama/fixture',
      roundNumber: 2,
      total: 20,
      costUsd: null,
      costReason: 'local, unpriced',
    },
  ];
  const display = gateSummaryDisplay(summary);
  assert.equal(display.tokens.mainWorker.label, 'Implementation');
  assert.equal(display.tokens.mainWorker.cost, '$0.2500');
  assert.equal(display.tokens.reviews[0].label, 'review-fixture round 1');
  assert.equal(display.tokens.reviews[0].cost, '$0.1250');
  assert.equal(display.tokens.reviews[1].cost, 'local, unpriced');
  assert.equal(display.tokens.grandCost, '$0.3750');
});

test('gate display explains an incomplete family cost', () => {
  const summary = gateSummaryWithChecklist(undefined);
  summary.tokens.familyCostUsd = null;
  summary.tokens.familyCostReason = 'Includes unpriced or uncaptured sessions';
  assert.equal(
    gateSummaryDisplay(summary).tokens.grandCost,
    'Includes unpriced or uncaptured sessions',
  );
});

// The run list's active-review label reads agent contexts, which a served row carries without
// their heavy keys: the same from the served row, the full run and an old cached row.
test('the active review label is the same from the served row, the full run and an old cached row', () => {
  const full: Run = {
    id: 'run-fix',
    familyId: 'family-fix',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'reviewing',
    project: 'farm',
    ticketOrPr: 'owner/repo#3',
    slotId: 'slot-1',
    branch: null,
    taskFile: null,
    steps: [{ name: 'review', status: 'running' }],
    decisions: [],
    agentContexts: [
      {
        id: 'review-fix',
        label: 'Review fix',
        role: 'review-fix',
        status: 'working',
        slotId: 'slot-1',
        runId: 'run-fix',
        usage: {
          totalTokens: 9000,
          measuredAt: '2026-11-01T00:00:00.000Z',
          source: 'runner-transcript',
        },
      },
    ],
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
  const expected = activePublicationReviewLabel(full);
  assert.equal(expected, 'Review fix');
  const row = runListRow(full);
  assert.equal(row.detailTrimmed, true);
  assert.equal(activePublicationReviewLabel(row), expected);
  assert.equal(activePublicationReviewLabel(trimRunForList(full)), expected);
});

// Review round 1's two inputs: the label reads a review's retry cap, retry count and issues,
// which a served row carries whole.
test('the gate label for a review at its retry cap is the same from the served row and the full run', () => {
  const gated = (review: ReviewStatus): Run => ({
    id: 'run-gate',
    familyId: 'family-gate',
    lane: 'production',
    flowType: 'fix-bug',
    status: 'human-gating',
    project: 'farm',
    ticketOrPr: 'owner/repo#4',
    slotId: 'slot-1',
    branch: null,
    taskFile: null,
    steps: [{ name: 'human-gate', status: 'running' }],
    decisions: [],
    engineState: { publishGate: { reviews: [review] } },
    metrics: { nudgeCount: 0, model: null, runner: null },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  });
  const review = { id: 'rev-1', mode: 'cold' as const, loopNumber: 1, verdict: 'issues' as const };
  const exhausted = gated({
    ...review,
    unresolvedCount: 0,
    issues: [{ file: 'src/main.ts', description: 'Unhandled error' }],
    maxRetries: 2,
    retryCount: 2,
  });
  assert.equal(compactHumanGateLabel(exhausted), 'review retries exhausted');
  assert.equal(compactHumanGateLabel(runListRow(exhausted)), 'review retries exhausted');
  const uncapped = gated({
    ...review,
    unresolvedCount: 1,
    maxRetries: 0,
    maxRetriesExhausted: true,
  });
  assert.equal(compactHumanGateLabel(uncapped), 'review blocked');
  assert.equal(compactHumanGateLabel(runListRow(uncapped)), 'review blocked');
});
