import assert from 'node:assert/strict';
import test from 'node:test';

import type { ReviewStatus } from '@farmslot/protocol';

import {
  APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  assertPublicationReviewPolicySatisfied,
  assertUnavailableSnapshotOverrideAvailable,
  buildPublishGateReviewStatus,
  buildUnavailableSnapshotAction,
  countStalePublicationReviews,
  reviewFinalSnapshotMatchesPreparedPackage,
  stampPublishGateReviewStatusForPackage,
  validatePackageApprovalSelection,
} from './gate-policy.js';
import { makeReadyGatePackage, makeRun } from './test-fixtures.js';

test('validatePackageApprovalSelection rejects package id, hash, and HEAD mismatches', () => {
  const pkg = makeReadyGatePackage();
  const decision = (selectionData: Record<string, unknown>) => ({ selectionData }) as any;
  assert.doesNotThrow(() =>
    validatePackageApprovalSelection(
      pkg,
      decision({
        packageId: pkg.id,
        packageHash: pkg.packageHash,
        packageHeadSha: pkg.headSha,
      }),
    ),
  );
  assert.doesNotThrow(() =>
    validatePackageApprovalSelection(
      {
        ...pkg,
        evidenceManifest: [{ path: 'artifacts/after.png', purpose: 'screenshot', sizeBytes: 10 }],
        selectedEvidenceKeys: ['artifacts/after.png'],
      },
      decision({
        packageId: pkg.id,
        packageHash: pkg.packageHash,
        packageHeadSha: pkg.headSha,
        selectedEvidenceKeys: ['./after.png'],
      }),
    ),
  );
  assert.throws(
    () =>
      validatePackageApprovalSelection(
        pkg,
        decision({
          packageId: 'pkg-other',
          packageHash: pkg.packageHash,
          packageHeadSha: pkg.headSha,
        }),
      ),
    /refresh package and re-review before publishing/i,
  );
  assert.throws(
    () =>
      validatePackageApprovalSelection(
        pkg,
        decision({
          packageId: pkg.id,
          packageHash: 'hash-other',
          packageHeadSha: pkg.headSha,
        }),
      ),
    /refresh package and re-review before publishing/i,
  );
  assert.throws(
    () =>
      validatePackageApprovalSelection(
        pkg,
        decision({
          packageId: pkg.id,
          packageHash: pkg.packageHash,
          packageHeadSha: 'def5678',
        }),
      ),
    /refresh package and re-review before publishing/i,
  );
  assert.throws(
    () =>
      validatePackageApprovalSelection(
        { ...pkg, selectedEvidenceKeys: ['artifacts/a.png'] },
        decision({
          packageId: pkg.id,
          packageHash: pkg.packageHash,
          packageHeadSha: pkg.headSha,
          selectedEvidenceKeys: [],
        }),
      ),
    /selected evidence differs/i,
  );
});

test('validatePackageApprovalSelection does not demand re-review when review depth is zero', () => {
  const pkg = makeReadyGatePackage({
    selectedEvidenceKeys: ['artifacts/a.png'],
    reviewPolicy: {
      minimumReviews: 0,
      requestedBy: 'dispatch',
    },
  });

  assert.throws(
    () =>
      validatePackageApprovalSelection(pkg, {
        selectionData: {
          packageId: pkg.id,
          packageHash: pkg.packageHash,
          packageHeadSha: pkg.headSha,
          selectedEvidenceKeys: [],
        },
      } as any),
    (error: Error) => {
      assert.match(error.message, /refresh package before publishing/);
      assert.doesNotMatch(error.message, /re-review/);
      return true;
    },
  );
});
test('publication review policy rejects stale and unavailable review snapshots', () => {
  const pkg = makeReadyGatePackage({ headSha: 'head-good' });
  const validRun = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'dispatch',
        },
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'dispatch',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewedReviewSubjectHash: 'subject-default',
            reviewSnapshot: {
              headSha: 'head-good',
              baseRef: pkg.reviewSnapshot?.baseRef,
              baseSha: pkg.reviewSnapshot?.baseSha,
              diffHash: pkg.reviewSnapshot?.diffHash,
              diffStat: pkg.diffStat,
              capturedAt: '2026-04-15T00:00:00.000Z',
              source: 'local-git',
            },
          },
        ],
      },
    },
  });
  assert.equal(countStalePublicationReviews(validRun.engineState!.publishGate!.reviews!, pkg), 0);
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(validRun, pkg));

  const unavailableRun = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'dispatch',
        },
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'dispatch',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewSnapshot: {
              capturedAt: '2026-04-15T00:00:00.000Z',
              source: 'unavailable',
              missingReason: 'head-unavailable',
            },
          },
        ],
      },
    },
  });
  assert.equal(
    countStalePublicationReviews(unavailableRun.engineState!.publishGate!.reviews!, pkg),
    0,
  );
  assert.throws(
    () => assertPublicationReviewPolicySatisfied(unavailableRun, pkg),
    /approved package/,
  );

  const staleRun = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'dispatch',
        },
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'dispatch',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewSnapshot: {
              headSha: 'head-old',
              capturedAt: '2026-04-15T00:00:00.000Z',
              source: 'local-git',
            },
          },
        ],
      },
    },
  });
  assert.equal(countStalePublicationReviews(staleRun.engineState!.publishGate!.reviews!, pkg), 1);
  assert.throws(() => assertPublicationReviewPolicySatisfied(staleRun, pkg), /approved package/);
});

test('snapshot-unavailable publication requires an explicit exact-package operator override', () => {
  const pkg = makeReadyGatePackage({
    headSha: 'head-good',
    reviewSnapshot: {
      source: 'unavailable',
      missingReason: 'slot-load-error',
      capturedAt: '2026-04-15T00:00:00.000Z',
    },
  });
  const reviewPolicy = {
    minimumReviews: 1,
    requestedBy: 'dispatch' as const,
  };
  const review: ReviewStatus = {
    reviewerSessionId: 'fixture-session-' + 'review-1',
    mode: 'cold' as const,
    id: 'review-1',
    source: 'dispatch',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    reviewedHeadSha: 'head-good',
    reviewedReviewSubjectHash: pkg.reviewSubjectHash,
    reviewSnapshot: {
      source: 'unavailable',
      missingReason: 'slot-load-error',
      capturedAt: '2026-04-15T00:00:00.000Z',
    },
  };
  const baseRun = makeRun({
    engineState: { publishGate: { reviewPolicy, reviews: [review] } },
  });

  assert.doesNotThrow(() =>
    assertUnavailableSnapshotOverrideAvailable([review], pkg, reviewPolicy),
  );
  assert.equal(
    buildUnavailableSnapshotAction([review], pkg, reviewPolicy)?.id,
    APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
  );
  assert.throws(
    () =>
      assertUnavailableSnapshotOverrideAvailable(
        [
          {
            ...review,
            reviewSnapshot: {
              source: 'local-git',
              headSha: 'head-reviewed-before-package-refresh',
              capturedAt: '2026-04-15T00:00:00.000Z',
            },
          },
        ],
        pkg,
        reviewPolicy,
      ),
    /exact package HEAD and subject/i,
  );
  assert.throws(() => assertPublicationReviewPolicySatisfied(baseRun, pkg), /approved package/);

  const approvedRun = makeRun({
    ...baseRun,
    decisions: [
      {
        id: 'decision-1',
        type: 'engine_human_gate',
        title: 'Publish',
        description: 'Snapshot unavailable',
        actions: [],
        createdAt: '2026-04-15T00:00:00.000Z',
        resolvedAt: '2026-04-15T00:01:00.000Z',
        resolvedAction: APPROVE_PUBLISH_SNAPSHOT_UNAVAILABLE_ACTION,
        payload: {
          kind: 'ready',
          prNumber: null,
          repo: null,
          diffStat: pkg.diffStat,
          workerReport: '',
          branch: pkg.branch,
          prPackage: pkg,
        },
      },
    ],
  });
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(approvedRun, pkg));
  const latestFailure: ReviewStatus = { ...review, verdict: 'issues', unresolvedCount: 1 };
  assert.throws(
    () => assertUnavailableSnapshotOverrideAvailable([review, latestFailure], pkg, reviewPolicy),
    /exact package HEAD and subject/,
  );
  assert.throws(
    () =>
      assertPublicationReviewPolicySatisfied(
        makeRun({
          ...approvedRun,
          engineState: { publishGate: { reviewPolicy, reviews: [review, latestFailure] } },
        }),
        pkg,
      ),
    /requires passing reviews/,
  );
});
test('publication review policy rejects semantic review subject drift', () => {
  const pkg = makeReadyGatePackage({
    headSha: 'head-good',
    reviewSubjectHash: 'subject-new',
  });
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'dispatch',
        },
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'dispatch',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewedHeadSha: 'head-good',
            reviewedReviewSubjectHash: 'subject-old',
            reviewSnapshot: {
              headSha: 'head-good',
              capturedAt: '2026-04-15T00:00:00.000Z',
              source: 'local-git',
            },
          },
        ],
      },
    },
  });
  assert.equal(countStalePublicationReviews(run.engineState!.publishGate!.reviews!, pkg), 1);
  assert.throws(() => assertPublicationReviewPolicySatisfied(run, pkg), /approved package/);

  const missingSubjectRun = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'dispatch',
        },
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'dispatch',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewedHeadSha: 'head-good',
            reviewSnapshot: {
              headSha: 'head-good',
              capturedAt: '2026-04-15T00:00:00.000Z',
              source: 'local-git',
            },
          },
        ],
      },
    },
  });
  assert.equal(
    countStalePublicationReviews(missingSubjectRun.engineState!.publishGate!.reviews!, pkg),
    1,
  );
  assert.throws(
    () => assertPublicationReviewPolicySatisfied(missingSubjectRun, pkg),
    /approved package/,
  );

  const packageMissingSubjectHash = makeReadyGatePackage({
    headSha: 'head-good',
    reviewSubjectHash: undefined,
  });
  const reviewWithMissingPackageSubjectRun = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'dispatch',
        },
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'dispatch',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            reviewedHeadSha: 'head-good',
            reviewedReviewSubjectHash: 'subject-default',
            reviewSnapshot: {
              headSha: 'head-good',
              capturedAt: '2026-04-15T00:00:00.000Z',
              source: 'local-git',
            },
          },
        ],
      },
    },
  });
  assert.equal(
    countStalePublicationReviews(
      reviewWithMissingPackageSubjectRun.engineState!.publishGate!.reviews!,
      packageMissingSubjectHash,
    ),
    1,
  );
  assert.throws(
    () =>
      assertPublicationReviewPolicySatisfied(
        reviewWithMissingPackageSubjectRun,
        packageMissingSubjectHash,
      ),
    /approved package/,
  );
});
test('publication review policy accepts zero-review package snapshots', () => {
  const pkg = makeReadyGatePackage({
    reviewPolicy: {
      minimumReviews: 0,
      requestedBy: 'dispatch',
    },
  });
  const run = makeRun({
    flowType: 'dev',
    mode: 'autonomous',
    engineState: { publishGate: { reviews: [] } },
  });
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(run, pkg));
});
test('publication review policy counts verified pipeline review approval', () => {
  const pkg = makeReadyGatePackage();
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: pkg.reviewPolicy,
        reviews: [
          {
            reviewerSessionId: 'fixture-session-' + 'review-1',
            mode: 'cold' as const,
            id: 'review-1',
            source: 'pipeline',
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            validationDepth: 'full-live',
            reviewedHeadSha: pkg.headSha,
            reviewedReviewSubjectHash: pkg.reviewSubjectHash,
            reviewSnapshot: {
              ...pkg.reviewSnapshot,
              headSha: pkg.headSha!,
              capturedAt: '2026-04-15T00:00:00.000Z',
              source: 'local-git',
            },
          },
        ],
      },
    },
  });

  assert.equal(countStalePublicationReviews(run.engineState!.publishGate!.reviews!, pkg), 0);
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(run, pkg));
});
test('publication review policy accepts stale reviews superseded by a fresh fix-loop certification', () => {
  const pkg = makeReadyGatePackage({ headSha: 'head-new', reviewSubjectHash: 'subject-new' });
  const reviews: ReviewStatus[] = [
    {
      reviewerSessionId: 'fixture-session-' + 'review-1',
      mode: 'cold' as const,
      id: 'review-1',
      source: 'pipeline',
      runner: 'claude',
      loopNumber: 1,
      verdict: 'pass',
      unresolvedCount: 0,
      validationDepth: 'full-live',
      reviewSnapshot: {
        headSha: 'head-old',
        capturedAt: '2026-04-15T00:00:00.000Z',
        source: 'local-git',
      },
    },
    {
      reviewerSessionId: 'fixture-session-' + 'review-2',
      mode: 'cold' as const,
      id: 'review-2',
      source: 'dispatch',
      runner: 'cursor',
      loopNumber: 2,
      verdict: 'pass',
      unresolvedCount: 0,
      validationDepth: 'static-code',
      reviewSnapshot: {
        headSha: 'head-old',
        capturedAt: '2026-04-15T00:10:00.000Z',
        source: 'local-git',
      },
    },
    {
      reviewerSessionId: 'fixture-session-' + 'review-3',
      mode: 'cold' as const,
      id: 'review-3',
      source: 'dispatch',
      runner: 'codex',
      loopNumber: 3,
      verdict: 'pass',
      unresolvedCount: 0,
      validationDepth: 'full-live',
      feedbackSent: true,
      reviewedReviewSubjectHash: 'subject-new',
      attempts: [
        {
          mode: 'cold' as const,
          loopNumber: 3,
          verdict: 'issues',
          unresolvedCount: 2,
          reviewSnapshot: {
            headSha: 'head-old',
            capturedAt: '2026-04-15T00:20:00.000Z',
            source: 'local-git',
          },
        },
        {
          mode: 'cold' as const,
          loopNumber: 3,
          verdict: 'pass',
          unresolvedCount: 0,
          reviewSnapshot: {
            headSha: 'head-new',
            capturedAt: '2026-04-15T00:40:00.000Z',
            source: 'local-git',
          },
        },
      ],
      timeline: [
        {
          kind: 'review',
          loopNumber: 3,
          startedAt: '2026-04-15T00:20:00.000Z',
          completedAt: '2026-04-15T00:30:00.000Z',
        },
        {
          kind: 'worker-fix',
          loopNumber: 3,
          startedAt: '2026-04-15T00:30:00.000Z',
          completedAt: '2026-04-15T00:35:00.000Z',
        },
        {
          kind: 're-review',
          loopNumber: 3,
          startedAt: '2026-04-15T00:35:00.000Z',
          completedAt: '2026-04-15T00:40:00.000Z',
        },
      ],
      reviewSnapshot: {
        ...pkg.reviewSnapshot,
        headSha: 'head-new',
        capturedAt: '2026-04-15T00:40:00.000Z',
        source: 'local-git',
      },
    },
  ];
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: {
          minimumReviews: 1,
          requestedBy: 'dispatch',
        },
        reviews: reviews,
      },
    },
  });

  assert.equal(countStalePublicationReviews(reviews, pkg), 0);
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(run, pkg));

  const twoReviewPackage = {
    ...pkg,
    reviewPolicy: { minimumReviews: 2, requestedBy: 'dispatch' as const },
  };
  assert.equal(countStalePublicationReviews(reviews, twoReviewPackage), 2);
  assert.throws(
    () => assertPublicationReviewPolicySatisfied(run, twoReviewPackage),
    /requires passing reviews/,
    'one current-head fix-loop approval cannot satisfy a minimum of two',
  );
  const secondCurrentApproval = {
    ...reviews[2]!,
    id: 'review-4',
    reviewerSessionId: 'fixture-session-review-4',
    feedbackSent: false,
    attempts: [],
    timeline: [],
  };
  const currentReviews = [...reviews, secondCurrentApproval];
  assert.equal(countStalePublicationReviews(currentReviews, twoReviewPackage), 0);
  assert.doesNotThrow(() =>
    assertPublicationReviewPolicySatisfied(
      makeRun({ engineState: { publishGate: { reviews: currentReviews } } }),
      twoReviewPackage,
    ),
  );

  const mismatchedSubjectCertification = reviews.map((review) =>
    review.id === 'review-3' ? { ...review, reviewedReviewSubjectHash: 'subject-old' } : review,
  );
  assert.equal(countStalePublicationReviews(mismatchedSubjectCertification, pkg) > 0, true);

  const missingSubjectCertification = reviews.map((review) =>
    review.id === 'review-3' ? { ...review, reviewedReviewSubjectHash: undefined } : review,
  );
  assert.equal(countStalePublicationReviews(missingSubjectCertification, pkg) > 0, true);
});
test('publication review policy accepts fresh re-review after package refresh without worker fix', () => {
  const pkg = makeReadyGatePackage({
    headSha: 'head-new',
    reviewSubjectHash: 'subject-new',
    reviewPolicy: {
      minimumReviews: 1,
      requestedBy: 'human-gate',
    },
  });
  const reviews: ReviewStatus[] = [
    {
      reviewerSessionId: 'fixture-session-' + 'review-1',
      mode: 'cold' as const,
      id: 'review-1',
      source: 'pipeline',
      runner: 'claude',
      loopNumber: 1,
      verdict: 'pass',
      unresolvedCount: 0,
      validationDepth: 'full-live',
      reviewedHeadSha: 'head-old',
      reviewedReviewSubjectHash: 'subject-old',
      reviewSnapshot: {
        headSha: 'head-old',
        capturedAt: '2026-04-15T00:00:00.000Z',
        source: 'local-git',
      },
    },
    {
      reviewerSessionId: 'fixture-session-' + 'review-2',
      mode: 'cold' as const,
      id: 'review-2',
      source: 'human-gate',
      runner: 'codex',
      loopNumber: 2,
      verdict: 'pass',
      unresolvedCount: 0,
      validationDepth: 'full-live',
      reviewedHeadSha: 'head-new',
      reviewedReviewSubjectHash: 'subject-new',
      reviewSnapshot: {
        headSha: 'head-new',
        baseRef: pkg.reviewSnapshot?.baseRef,
        baseSha: pkg.reviewSnapshot?.baseSha,
        diffHash: pkg.reviewSnapshot?.diffHash,
        diffStat: pkg.diffStat,
        capturedAt: '2026-04-15T00:10:00.000Z',
        source: 'local-git',
      },
    },
  ];
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewPolicy: pkg.reviewPolicy,
        reviews: reviews,
      },
    },
  });

  assert.equal(countStalePublicationReviews(reviews, pkg), 0);
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(run, pkg));
});
test('buildPublishGateReviewStatus coalesces retry attempts into one configured review', () => {
  const status = buildPublishGateReviewStatus({
    source: 'dispatch',
    priorReviewCount: 2,
    requestedRunner: 'cursor',
    model: 'opus',
    reviewResult: {
      verdict: 'issues',
      issues: [{ file: 'a.ts', description: 'still flaky' }],
      runner: 'cursor',
      model: 'composer-2.5',
      validationDepth: 'static-code',
      retryCount: 2,
      feedbackSent: true,
      recoveryContinuationPending: false,
      attempts: [
        {
          mode: 'cold' as const,
          loopNumber: 1,
          verdict: 'issues',
          unresolvedCount: 2,
          issues: [{ file: 'a.ts', description: 'first finding' }],
          artifactPaths: ['artifacts/review-loop-1/review.diff'],
          taskProgressArtifactPath: 'tasks/foo/artifacts/review-3/review-loop-1/review.md',
          startedAt: '2026-05-08T00:00:00.000Z',
          completedAt: '2026-05-08T00:02:00.000Z',
          timeline: [
            {
              kind: 'review',
              loopNumber: 1,
              runner: 'cursor',
              model: 'composer-2.5',
              startedAt: '2026-05-08T00:00:00.000Z',
              completedAt: '2026-05-08T00:02:00.000Z',
              durationMs: 120000,
            },
          ],
          reviewSnapshot: {
            source: 'local-git',
            capturedAt: '2026-05-08T00:00:00.000Z',
            headSha: 'old',
          },
        },
        {
          mode: 'cold' as const,
          loopNumber: 2,
          verdict: 'issues',
          unresolvedCount: 1,
          artifactPaths: ['artifacts/review-loop-2/review.diff'],
          taskProgressArtifactPath: 'tasks/foo/artifacts/review-3/review-loop-2/review.md',
          startedAt: '2026-05-08T00:03:00.000Z',
          completedAt: '2026-05-08T00:04:00.000Z',
          timeline: [
            {
              kind: 're-review',
              loopNumber: 2,
              runner: 'cursor',
              model: 'composer-2.5',
              startedAt: '2026-05-08T00:03:00.000Z',
              completedAt: '2026-05-08T00:04:00.000Z',
              durationMs: 60000,
            },
          ],
          reviewSnapshot: {
            source: 'local-git',
            capturedAt: '2026-05-08T00:01:00.000Z',
            headSha: 'new',
          },
        },
      ],
    },
  });

  assert.equal(status.id, 'review-3');
  assert.equal(status.runner, 'cursor');
  assert.equal(status.verdict, 'issues');
  assert.equal(status.unresolvedCount, 1);
  assert.equal(status.validationDepth, 'static-code');
  assert.equal(status.attempts?.length, 2);
  assert.equal(
    status.taskProgressArtifactPath,
    'tasks/foo/artifacts/review-3/review-loop-2/review.md',
  );
  assert.equal(status.startedAt, '2026-05-08T00:00:00.000Z');
  assert.equal(status.completedAt, '2026-05-08T00:04:00.000Z');
  assert.deepEqual(
    status.timeline?.map((segment) => ({ kind: segment.kind, durationMs: segment.durationMs })),
    [
      { kind: 'review', durationMs: 120000 },
      { kind: 're-review', durationMs: 60000 },
    ],
  );
  assert.deepEqual(status.issues, [{ file: 'a.ts', description: 'still flaky' }]);
  assert.equal(status.feedbackSent, true);
  assert.equal(status.recoveryContinuationPending, false);
  assert.equal(status.reviewSnapshot?.headSha, 'new');
  assert.deepEqual(status.artifactPaths, [
    'artifacts/review-loop-1/review.diff',
    'artifacts/review-loop-2/review.diff',
  ]);
});
test('buildPublishGateReviewStatus clears continuation when retries are exhausted', () => {
  const status = buildPublishGateReviewStatus({
    source: 'human-gate',
    priorReviewCount: 2,
    requestedRunner: 'cursor',
    reviewResult: {
      verdict: 'issues',
      issues: [{ file: 'a.ts', description: 'still broken' }],
      retryCount: 3,
      maxRetries: 3,
      recoveryContinuationPending: true,
      feedbackSent: false,
    },
  });
  assert.equal(status.maxRetriesExhausted, true);
  assert.equal(status.recoveryContinuationPending, false);
});

test('buildPublishGateReviewStatus repairs a wiped retryCount from attempts', () => {
  const status = buildPublishGateReviewStatus({
    source: 'human-gate',
    priorReviewCount: 2,
    requestedRunner: 'cursor',
    reviewResult: {
      verdict: 'issues',
      issues: [{ file: 'a.ts', description: 'still broken' }],
      retryCount: 0,
      maxRetries: 3,
      recoveryContinuationPending: true,
      feedbackSent: false,
      attempts: [
        { mode: 'cold' as const, loopNumber: 1, verdict: 'issues', unresolvedCount: 4 },
        { mode: 'cold' as const, loopNumber: 2, verdict: 'issues', unresolvedCount: 9 },
        { mode: 'cold' as const, loopNumber: 3, verdict: 'issues', unresolvedCount: 8 },
        { mode: 'cold' as const, loopNumber: 4, verdict: 'issues', unresolvedCount: 7 },
      ],
    },
  });
  assert.equal(status.retryCount, 3);
  assert.equal(status.maxRetriesExhausted, true);
  assert.equal(status.recoveryContinuationPending, false);
});

test('buildPublishGateReviewStatus stamps the prepared package that was reviewed', () => {
  const status = buildPublishGateReviewStatus({
    source: 'human-gate',
    priorReviewCount: 1,
    requestedRunner: 'codex',
    reviewedPackage: {
      headSha: 'reviewed-head',
      packageInputHash: 'package-input-hash',
      reviewSubjectHash: 'review-subject-hash',
    },
    reviewResult: {
      verdict: 'pass',
      runner: 'codex',
      retryCount: 0,
      reviewSnapshot: {
        source: 'local-git',
        capturedAt: '2026-05-18T00:00:00.000Z',
        headSha: 'reviewed-head',
      },
    },
  });

  assert.equal(status.reviewedHeadSha, 'reviewed-head');
  assert.equal(status.reviewedPackageInputHash, 'package-input-hash');
  assert.equal(status.reviewedReviewSubjectHash, 'review-subject-hash');
});
test('buildPublishGateReviewStatus preserves the final re-review head after worker fixes', () => {
  const status = buildPublishGateReviewStatus({
    source: 'human-gate',
    priorReviewCount: 1,
    requestedRunner: 'claude',
    reviewedPackage: {
      headSha: 'old-head',
      packageInputHash: 'old-package-input',
      reviewSubjectHash: 'old-subject',
    },
    reviewResult: {
      verdict: 'pass',
      runner: 'claude',
      retryCount: 1,
      attempts: [
        {
          mode: 'cold' as const,
          loopNumber: 2,
          verdict: 'issues',
          unresolvedCount: 1,
          reviewSnapshot: {
            source: 'local-git',
            capturedAt: '2026-05-18T00:00:00.000Z',
            headSha: 'old-head',
            diffStat: { files: 1, additions: 2, deletions: 3 },
          },
        },
        {
          mode: 'cold' as const,
          loopNumber: 3,
          verdict: 'pass',
          unresolvedCount: 0,
          reviewSnapshot: {
            source: 'local-git',
            capturedAt: '2026-05-18T00:10:00.000Z',
            headSha: 'new-head',
            baseRef: 'origin/main',
            baseSha: 'base-default',
            diffHash: 'new-diff',
            diffStat: { files: 1, additions: 2, deletions: 3 },
          },
        },
      ],
    },
  });

  assert.equal(status.reviewedHeadSha, 'new-head');
  assert.equal(status.reviewSnapshot?.headSha, 'new-head');
  assert.equal(status.reviewedPackageInputHash, undefined);
  assert.equal(status.reviewedReviewSubjectHash, undefined);
  assert.equal(
    reviewFinalSnapshotMatchesPreparedPackage(status, {
      headSha: 'new-head',
      reviewSnapshot: {
        source: 'local-git',
        capturedAt: '2026-05-18T00:11:00.000Z',
        headSha: 'new-head',
        baseRef: 'origin/main',
        baseSha: 'base-default',
        diffHash: 'new-diff',
      },
    }),
    true,
  );
  assert.equal(
    reviewFinalSnapshotMatchesPreparedPackage(status, {
      headSha: 'old-head',
      reviewSnapshot: {
        source: 'local-git',
        capturedAt: '2026-05-18T00:11:00.000Z',
        headSha: 'old-head',
        baseRef: 'origin/main',
        baseSha: 'base-default',
        diffHash: 'new-diff',
      },
    }),
    false,
  );
  assert.equal(
    reviewFinalSnapshotMatchesPreparedPackage(status, {
      headSha: 'new-head',
      reviewSnapshot: {
        source: 'local-git',
        capturedAt: '2026-05-18T00:11:00.000Z',
        headSha: 'new-head',
        baseRef: 'origin/main',
        baseSha: 'base-default',
        diffHash: 'different-diff',
      },
    }),
    false,
  );
});
test('stampPublishGateReviewStatusForPackage only certifies the selected review', () => {
  const staleReview: ReviewStatus = {
    reviewerSessionId: 'fixture-session-' + 'review-2',
    mode: 'cold' as const,
    id: 'review-2',
    source: 'human-gate',
    runner: 'codex',
    loopNumber: 2,
    verdict: 'pass',
    unresolvedCount: 0,
    reviewedHeadSha: 'old-head',
    reviewedReviewSubjectHash: 'old-subject',
    reviewSnapshot: {
      source: 'local-git',
      capturedAt: '2026-05-18T00:00:00.000Z',
      headSha: 'new-head',
    },
  };

  const stamped = stampPublishGateReviewStatusForPackage(staleReview, {
    headSha: 'new-head',
    packageInputHash: 'new-input',
    reviewSubjectHash: 'new-subject',
  });

  assert.equal(stamped.id, staleReview.id);
  assert.equal(stamped.reviewedHeadSha, 'new-head');
  assert.equal(stamped.reviewedPackageInputHash, 'new-input');
  assert.equal(stamped.reviewedReviewSubjectHash, 'new-subject');
  assert.equal(staleReview.reviewedReviewSubjectHash, 'old-subject');
});

test('buildPublishGateReviewStatus does not publish a pass for a blocked review loop', () => {
  const pkg = makeReadyGatePackage({
    headSha: 'blocked-head',
    reviewSubjectHash: 'subject-blocked',
    reviewPolicy: {
      minimumReviews: 1,
      requestedBy: 'human-gate',
    },
  });
  const status = buildPublishGateReviewStatus({
    source: 'human-gate',
    priorReviewCount: 0,
    requestedRunner: 'claude',
    reviewedPackage: pkg,
    reviewResult: {
      verdict: 'blocked',
      reason: 'external dependency unavailable',
      runner: 'claude',
      retryCount: 1,
      attempts: [
        { mode: 'cold' as const, loopNumber: 1, verdict: 'issues', unresolvedCount: 2 },
        // The worker blocked mid-fix and the re-review of its partial changes
        // passed. The final attempt carries the block, so the aggregate verdict
        // stays authoritative and this review cannot satisfy publication.
        {
          mode: 'cold' as const,
          loopNumber: 2,
          verdict: 'failed',
          reason: 'external dependency unavailable',
          unresolvedCount: 0,
          reviewSnapshot: {
            headSha: 'blocked-head',
            capturedAt: '2026-09-03T00:00:00.000Z',
            source: 'local-git',
          },
        },
      ],
    },
  });

  assert.equal(status.verdict, 'failed');
  assert.equal(status.reason, 'external dependency unavailable');

  const run = makeRun({
    engineState: {
      publishGate: { reviewPolicy: pkg.reviewPolicy, reviews: [status] },
    },
  });
  assert.throws(() => assertPublicationReviewPolicySatisfied(run, pkg), /requires passing reviews/);
});

test('a verified WARM delta certifies the current full PR package head', () => {
  const pkg = makeReadyGatePackage({
    headSha: 'current',
    reviewSubjectHash: 'subject',
    reviewSnapshot: {
      source: 'local-git',
      capturedAt: 'now',
      baseSha: 'pr-base',
      baseRef: 'origin/main',
      headSha: 'current',
      diffHash: 'whole-pr',
    },
  });
  const review: ReviewStatus = {
    id: 'review-warm',
    mode: 'warm',
    reviewerSessionId: 'retained-session',
    loopNumber: 1,
    verdict: 'pass',
    unresolvedCount: 0,
    reviewedHeadSha: 'current',
    reviewedReviewSubjectHash: 'subject',
    session: {
      mode: 'warm',
      continuity: 'resumed',
      reviewId: 'review-warm',
      sessionId: 'retained-session',
      lastReviewedHeadSha: 'previous',
    },
    reviewSnapshot: {
      source: 'local-git',
      capturedAt: 'now',
      baseSha: 'previous',
      baseRef: 'origin/main',
      headSha: 'current',
      diffHash: 'delta',
    },
  };
  assert.equal(reviewFinalSnapshotMatchesPreparedPackage(review, pkg), true);
  const attached = {
    ...pkg,
    reviewSnapshot: { ...pkg.reviewSnapshot!, baseRef: 'origin/feature/parent' },
  };
  assert.equal(reviewFinalSnapshotMatchesPreparedPackage(review, attached), false);
  assert.throws(
    () =>
      assertPublicationReviewPolicySatisfied(
        makeRun({ engineState: { publishGate: { reviews: [review] } } }),
        attached,
      ),
    /requires passing reviews/,
  );
  assert.equal(
    reviewFinalSnapshotMatchesPreparedPackage(
      { ...review, session: { ...review.session!, lastReviewedHeadSha: 'current' } },
      pkg,
    ),
    false,
    'the WARM result retains the prior reviewed head, not the advanced retained binding',
  );
  assert.doesNotThrow(() =>
    assertPublicationReviewPolicySatisfied(
      makeRun({ engineState: { publishGate: { reviews: [review] } } }),
      pkg,
    ),
  );
  assert.equal(
    reviewFinalSnapshotMatchesPreparedPackage(
      { ...review, session: { ...review.session!, reviewId: 'foreign' } },
      pkg,
    ),
    false,
  );
});
