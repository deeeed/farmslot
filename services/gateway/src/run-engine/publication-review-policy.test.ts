import assert from 'node:assert/strict';
import test from 'node:test';

import type { IndependentReviewStatus } from '@farmslot/protocol';

import {
  assertPublicationReviewPolicySatisfied,
  buildPublishGateReviewStatus,
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
test('publication review policy rejects stale and unavailable review snapshots', () => {
  const pkg = makeReadyGatePackage({ headSha: 'head-good' });
  const validRun = makeRun({
    engineState: {
      publishGate: {
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: false,
          extraLoopsRequested: 0,
          requestedBy: 'dispatch',
        },
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'dispatch',
            crossRunner: false,
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
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
    countStalePublicationReviews(validRun.engineState!.publishGate!.independentReviews!, pkg),
    0,
  );
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(validRun, pkg));

  const unavailableRun = makeRun({
    engineState: {
      publishGate: {
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: false,
          extraLoopsRequested: 0,
          requestedBy: 'dispatch',
        },
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'dispatch',
            crossRunner: false,
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
    countStalePublicationReviews(unavailableRun.engineState!.publishGate!.independentReviews!, pkg),
    1,
  );
  assert.throws(
    () => assertPublicationReviewPolicySatisfied(unavailableRun, pkg),
    /approved package/,
  );

  const staleRun = makeRun({
    engineState: {
      publishGate: {
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: false,
          extraLoopsRequested: 0,
          requestedBy: 'dispatch',
        },
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'dispatch',
            crossRunner: false,
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
  assert.equal(
    countStalePublicationReviews(staleRun.engineState!.publishGate!.independentReviews!, pkg),
    1,
  );
  assert.throws(() => assertPublicationReviewPolicySatisfied(staleRun, pkg), /approved package/);
});
test('publication review policy rejects semantic review subject drift', () => {
  const pkg = makeReadyGatePackage({
    headSha: 'head-good',
    reviewSubjectHash: 'subject-new',
  });
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: false,
          extraLoopsRequested: 0,
          requestedBy: 'dispatch',
        },
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'dispatch',
            crossRunner: false,
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
  assert.equal(
    countStalePublicationReviews(run.engineState!.publishGate!.independentReviews!, pkg),
    1,
  );
  assert.throws(() => assertPublicationReviewPolicySatisfied(run, pkg), /approved package/);

  const missingSubjectRun = makeRun({
    engineState: {
      publishGate: {
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: false,
          extraLoopsRequested: 0,
          requestedBy: 'dispatch',
        },
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'dispatch',
            crossRunner: false,
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
    countStalePublicationReviews(
      missingSubjectRun.engineState!.publishGate!.independentReviews!,
      pkg,
    ),
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
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: false,
          extraLoopsRequested: 0,
          requestedBy: 'dispatch',
        },
        independentReviews: [
          {
            id: 'independent-review-1',
            source: 'dispatch',
            crossRunner: false,
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
      reviewWithMissingPackageSubjectRun.engineState!.publishGate!.independentReviews!,
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
    reviewDepth: {
      minimumIndependentReviews: 0,
      requireCrossRunner: false,
      extraLoopsRequested: 0,
      requestedBy: 'dispatch',
    },
  });
  const run = makeRun({
    flowType: 'dev',
    mode: 'autonomous',
    engineState: { publishGate: { independentReviews: [] } },
  });
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(run, pkg));
});
test('publication review policy does not count worker self-review as independent approval', () => {
  const pkg = makeReadyGatePackage();
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewDepth: pkg.reviewDepth,
        independentReviews: [
          {
            id: 'self-review-1',
            source: 'self-review',
            crossRunner: true,
            loopNumber: 1,
            verdict: 'pass',
            unresolvedCount: 0,
            validationDepth: 'full-live',
            reviewedHeadSha: pkg.headSha,
            reviewedReviewSubjectHash: pkg.reviewSubjectHash,
            reviewSnapshot: {
              headSha: pkg.headSha!,
              capturedAt: '2026-04-15T00:00:00.000Z',
              source: 'local-git',
            },
          },
        ],
      },
    },
  });

  assert.equal(
    countStalePublicationReviews(run.engineState!.publishGate!.independentReviews!, pkg),
    0,
  );
  assert.throws(() => assertPublicationReviewPolicySatisfied(run, pkg), /independent reviews/);
});
test('publication review policy accepts stale reviews superseded by a fresh fix-loop certification', () => {
  const pkg = makeReadyGatePackage({ headSha: 'head-new', reviewSubjectHash: 'subject-new' });
  const reviews: IndependentReviewStatus[] = [
    {
      id: 'self-review-1',
      source: 'self-review',
      runner: 'claude',
      crossRunner: false,
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
      id: 'independent-review-2',
      source: 'dispatch',
      runner: 'cursor',
      crossRunner: true,
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
      id: 'independent-review-3',
      source: 'dispatch',
      runner: 'codex',
      crossRunner: true,
      loopNumber: 3,
      verdict: 'pass',
      unresolvedCount: 0,
      validationDepth: 'full-live',
      feedbackSent: true,
      reviewedReviewSubjectHash: 'subject-new',
      attempts: [
        {
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
        headSha: 'head-new',
        capturedAt: '2026-04-15T00:40:00.000Z',
        source: 'local-git',
      },
    },
  ];
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewDepth: {
          minimumIndependentReviews: 1,
          requireCrossRunner: true,
          extraLoopsRequested: 2,
          requestedBy: 'dispatch',
        },
        independentReviews: reviews,
      },
    },
  });

  assert.equal(
    countStalePublicationReviews(reviews, pkg, { requireCrossRunnerCertification: true }),
    0,
  );
  assert.doesNotThrow(() => assertPublicationReviewPolicySatisfied(run, pkg));

  const mismatchedSubjectCertification = reviews.map((review) =>
    review.id === 'independent-review-3'
      ? { ...review, reviewedReviewSubjectHash: 'subject-old' }
      : review,
  );
  assert.equal(
    countStalePublicationReviews(mismatchedSubjectCertification, pkg, {
      requireCrossRunnerCertification: true,
    }) > 0,
    true,
  );

  const missingSubjectCertification = reviews.map((review) =>
    review.id === 'independent-review-3'
      ? { ...review, reviewedReviewSubjectHash: undefined }
      : review,
  );
  assert.equal(
    countStalePublicationReviews(missingSubjectCertification, pkg, {
      requireCrossRunnerCertification: true,
    }) > 0,
    true,
  );

  const sameRunnerCertification = reviews.map((review) =>
    review.id === 'independent-review-3' ? { ...review, crossRunner: false } : review,
  );
  assert.equal(
    countStalePublicationReviews(sameRunnerCertification, pkg, {
      requireCrossRunnerCertification: true,
    }) > 0,
    true,
  );
});
test('publication review policy accepts fresh re-review after package refresh without worker fix', () => {
  const pkg = makeReadyGatePackage({
    headSha: 'head-new',
    reviewSubjectHash: 'subject-new',
    reviewDepth: {
      minimumIndependentReviews: 1,
      requireCrossRunner: false,
      extraLoopsRequested: 0,
      requestedBy: 'human-gate',
    },
  });
  const reviews: IndependentReviewStatus[] = [
    {
      id: 'self-review-1',
      source: 'self-review',
      runner: 'claude',
      crossRunner: false,
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
      id: 'independent-review-2',
      source: 'human-gate',
      runner: 'codex',
      crossRunner: false,
      loopNumber: 2,
      verdict: 'pass',
      unresolvedCount: 0,
      validationDepth: 'full-live',
      reviewedHeadSha: 'head-new',
      reviewedReviewSubjectHash: 'subject-new',
      reviewSnapshot: {
        headSha: 'head-new',
        capturedAt: '2026-04-15T00:10:00.000Z',
        source: 'local-git',
      },
    },
  ];
  const run = makeRun({
    engineState: {
      publishGate: {
        reviewDepth: pkg.reviewDepth,
        independentReviews: reviews,
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
    workerRunner: 'claude',
    model: 'opus',
    reviewResult: {
      verdict: 'issues',
      issues: [{ file: 'a.ts', description: 'still flaky' }],
      runner: 'cursor',
      model: 'composer-2.5',
      crossRunner: true,
      validationDepth: 'static-code',
      retryCount: 2,
      attempts: [
        {
          loopNumber: 1,
          verdict: 'issues',
          unresolvedCount: 2,
          issues: [{ file: 'a.ts', description: 'first finding' }],
          artifactPaths: ['artifacts/review-loop-1/review.diff'],
          taskProgressArtifactPath:
            'tasks/foo/artifacts/independent-review-3/review-loop-1/self-review.md',
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
          loopNumber: 2,
          verdict: 'issues',
          unresolvedCount: 1,
          artifactPaths: ['artifacts/review-loop-2/review.diff'],
          taskProgressArtifactPath:
            'tasks/foo/artifacts/independent-review-3/review-loop-2/self-review.md',
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

  assert.equal(status.id, 'independent-review-3');
  assert.equal(status.runner, 'cursor');
  assert.equal(status.crossRunner, true);
  assert.equal(status.verdict, 'issues');
  assert.equal(status.unresolvedCount, 1);
  assert.equal(status.validationDepth, 'static-code');
  assert.equal(status.attempts?.length, 2);
  assert.equal(
    status.taskProgressArtifactPath,
    'tasks/foo/artifacts/independent-review-3/review-loop-2/self-review.md',
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
  assert.equal(status.reviewSnapshot?.headSha, 'new');
  assert.deepEqual(status.artifactPaths, [
    'artifacts/review-loop-1/review.diff',
    'artifacts/review-loop-2/review.diff',
  ]);
});
test('buildPublishGateReviewStatus stamps the prepared package that was reviewed', () => {
  const status = buildPublishGateReviewStatus({
    source: 'human-gate',
    priorReviewCount: 1,
    requestedRunner: 'codex',
    workerRunner: 'claude',
    reviewedPackage: {
      headSha: 'reviewed-head',
      packageInputHash: 'package-input-hash',
      reviewSubjectHash: 'review-subject-hash',
    },
    reviewResult: {
      verdict: 'pass',
      runner: 'codex',
      crossRunner: true,
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
    workerRunner: 'codex',
    reviewedPackage: {
      headSha: 'old-head',
      packageInputHash: 'old-package-input',
      reviewSubjectHash: 'old-subject',
    },
    reviewResult: {
      verdict: 'pass',
      runner: 'claude',
      crossRunner: true,
      retryCount: 1,
      attempts: [
        {
          loopNumber: 2,
          verdict: 'issues',
          unresolvedCount: 1,
          reviewSnapshot: {
            source: 'local-git',
            capturedAt: '2026-05-18T00:00:00.000Z',
            headSha: 'old-head',
          },
        },
        {
          loopNumber: 3,
          verdict: 'pass',
          unresolvedCount: 0,
          reviewSnapshot: {
            source: 'local-git',
            capturedAt: '2026-05-18T00:10:00.000Z',
            headSha: 'new-head',
          },
        },
      ],
    },
  });

  assert.equal(status.reviewedHeadSha, 'new-head');
  assert.equal(status.reviewSnapshot?.headSha, 'new-head');
  assert.equal(status.reviewedPackageInputHash, undefined);
  assert.equal(status.reviewedReviewSubjectHash, undefined);
  assert.equal(reviewFinalSnapshotMatchesPreparedPackage(status, { headSha: 'new-head' }), true);
  assert.equal(reviewFinalSnapshotMatchesPreparedPackage(status, { headSha: 'old-head' }), false);
});
test('stampPublishGateReviewStatusForPackage only certifies the selected review', () => {
  const staleReview: IndependentReviewStatus = {
    id: 'independent-review-2',
    source: 'human-gate',
    runner: 'codex',
    crossRunner: true,
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
