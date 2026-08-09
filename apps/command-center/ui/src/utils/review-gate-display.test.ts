import assert from 'node:assert/strict';
import test from 'node:test';

import type { IndependentReviewStatus, ReadyGatePayload } from '@farmslot/protocol';

import {
  activePublicationReviewLabel,
  classifyReviewFreshness,
  compactHumanGateLabel,
  fixDeltaAbsenceReason,
  formatTokenCount,
  hasMeaningfulReviewFixDelta,
  publishEvidenceDisplayRows,
  readyReviewBlockingDisplayReason,
  reviewAttemptLabel,
  reviewHasPendingContinuationPhases,
  reviewPolicyLabel,
  reviewSegmentLabel,
  summarizeReviewCounts,
} from './review-gate-display.js';

function payload(review: Partial<IndependentReviewStatus>): ReadyGatePayload {
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
      reviewDepth: {
        minimumIndependentReviews: 1,
        requireCrossRunner: false,
        extraLoopsRequested: 0,
        requestedBy: 'dispatch',
      },
      publicationTarget: 'ready',
      publicationStatus: 'not_published',
      createdAt: '2026-05-18T00:00:00.000Z',
    },
    independentReviews: [
      {
        id: 'review-1',
        crossRunner: false,
        loopNumber: 1,
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
      payload({ reviewedHeadSha: 'head-old' }).independentReviews![0],
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
    classifyReviewFreshness(staleSubject.independentReviews![0], staleSubject).reason,
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
    classifyReviewFreshness(unavailable.independentReviews![0], unavailable).reason,
    'review-snapshot-unavailable',
  );
  assert.match(readyReviewBlockingDisplayReason(unavailable), /snapshot unavailable/);
});

test('summarizeReviewCounts separates required, fresh, stale, attempts, external and unresolved counts', () => {
  const fixture = payload({
    attempts: [
      { loopNumber: 1, verdict: 'issues', unresolvedCount: 1 },
      { loopNumber: 2, verdict: 'pass', unresolvedCount: 0 },
    ],
  });
  fixture.prPackage!.reviewDepth = {
    minimumIndependentReviews: 1,
    requireCrossRunner: true,
    extraLoopsRequested: 1,
    requestedBy: 'human-gate',
  };
  fixture.independentReviews = [
    fixture.independentReviews![0],
    {
      ...fixture.independentReviews![0],
      id: 'review-stale',
      crossRunner: true,
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
  assert.equal(summary.requiredReviews, 2);
  assert.equal(summary.freshPassingReviews, 1);
  assert.equal(summary.staleIgnoredReviews, 1);
  assert.equal(summary.totalAttempts, 3);
  assert.equal(summary.externalRequired, true);
  assert.equal(summary.externalFreshPassingReviews, 0);
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

test('review labels use Independent review with runner diversity as policy metadata', () => {
  const requested = payload({ source: 'human-gate', crossRunner: true }).independentReviews![0];
  assert.equal(reviewAttemptLabel(requested, 1, 2), 'Independent review (requested) attempt 2/2');
  assert.equal(reviewSegmentLabel(requested, 1), 'Independent review (requested) 1');
  // Runner diversity is not a review kind — it renders as a policy label.
  assert.equal(reviewPolicyLabel({ crossRunner: true, runner: 'codex' }), 'runner: codex');
  assert.equal(reviewPolicyLabel({ crossRunner: true }), 'runner diversity');
  assert.equal(reviewPolicyLabel({ crossRunner: false, runner: 'codex' }), null);
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
    .independentReviews![0];
  assert.match(fixDeltaAbsenceReason(auditOnly, undefined), /audit-only review/);

  const unavailable = payload({
    fixDelta: {
      source: 'unavailable',
      capturedAt: '2026-05-18T00:00:00.000Z',
      missingReason: 'fix-base-unavailable',
    },
  }).independentReviews![0];
  assert.match(fixDeltaAbsenceReason(unavailable, undefined), /fix-base-unavailable/);

  const unchanged = payload({
    fixDelta: {
      source: 'local-git',
      capturedAt: '2026-05-18T00:00:00.000Z',
      baseSha: 'same-sha',
      headSha: 'same-sha',
    },
  }).independentReviews![0];
  assert.equal(hasMeaningfulReviewFixDelta(unchanged.fixDelta), false);
  assert.match(fixDeltaAbsenceReason(unchanged, undefined), /No tracked worker change/);
});

test('summarizeReviewCounts mirrors gateway fix-loop certification by trusting passing reviews', () => {
  const fixture = payload({
    reviewedHeadSha: 'old-head',
    reviewedReviewSubjectHash: 'subject-new-1234567890',
    reviewSnapshot: {
      source: 'local-git',
      headSha: 'head-new-1234567890',
      capturedAt: '2026-05-18T00:00:00.000Z',
    },
    validationDepth: 'full-live',
    feedbackSent: false,
    attempts: [
      { loopNumber: 1, verdict: 'issues', unresolvedCount: 1 },
      { loopNumber: 2, verdict: 'pass', unresolvedCount: 0 },
    ],
  });

  const summary = summarizeReviewCounts(fixture);
  assert.equal(summary.freshPassingReviews, 0);
  assert.equal(summary.fixLoopCertified, true);
  assert.equal(summary.trustedPassingReviews, 1);
  assert.equal(summary.staleIgnoredReviews, 0);
});

test('classifyReviewFreshness treats missing package review subject as stale', () => {
  const fixture = payload({});
  delete fixture.prPackage!.reviewSubjectHash;

  const freshness = classifyReviewFreshness(fixture.independentReviews![0], fixture);
  assert.equal(freshness.reason, 'package-review-subject-missing');
  assert.match(readyReviewBlockingDisplayReason(fixture), /review-subject hash/);
});

test('review labels preserve self-review source', () => {
  const review = payload({ source: 'self-review', crossRunner: false }).independentReviews![0];
  assert.equal(reviewAttemptLabel(review, 0, 1), 'Self-review attempt');
  assert.equal(reviewSegmentLabel(review, 2), 'Self-review 2');
});

test('compact human-gate labels prioritize the active independent review loop', () => {
  const activeFix = {
    agentContexts: [
      {
        id: 'self-review-fix',
        role: 'self-review-fix' as const,
        label: 'Review fix',
        status: 'working' as const,
        slotId: 'slot-1',
        runId: 'run-1',
      },
    ],
    decisions: [],
  };
  assert.equal(activePublicationReviewLabel(activeFix), 'Independent review fix');
  assert.equal(compactHumanGateLabel(activeFix), 'independent review fix');

  assert.equal(
    compactHumanGateLabel({
      agentContexts: [],
      decisions: [],
      engineState: {
        publishGate: {
          pendingReviewPlan: [{ order: 1, runner: 'codex', validationDepth: 'static-code' }],
        },
      },
    }),
    'independent review',
  );

  assert.equal(
    compactHumanGateLabel({
      agentContexts: [],
      decisions: [],
      engineState: {
        publishGate: {
          pendingReviewPlan: [{ order: 1, runner: 'codex', validationDepth: 'static-code' }],
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
          independentReviews: [
            {
              id: 'independent-review-1',
              source: 'human-gate',
              crossRunner: true,
              loopNumber: 1,
              verdict: 'issues',
              unresolvedCount: 2,
            },
          ],
        },
      },
    }),
    'review blocked',
  );
});

test('readyReviewBlockingDisplayReason cites stale reviews even when fresh quorum is satisfied', () => {
  const fixture = payload({});
  fixture.prPackage!.reviewDepth = {
    minimumIndependentReviews: 1,
    requireCrossRunner: false,
    extraLoopsRequested: 0,
    requestedBy: 'dispatch',
  };
  fixture.independentReviews = [
    fixture.independentReviews![0],
    {
      ...fixture.independentReviews![0],
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
