import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecResult, ReviewStatus } from '@farmslot/protocol';

import {
  assertReviewLaunchState,
  publicationReviewLaunchRejectionFromError,
} from './review-launch-gate.js';

function gitExecutor(
  status: string,
  headSha: string,
  ignoredPaths?: readonly string[],
): (command: string) => Promise<ExecResult> {
  return async (command) => {
    if (command.includes('status --porcelain')) {
      return { stdout: status, stderr: '', exitCode: 0 };
    }
    if (command.includes('rev-parse HEAD')) {
      return { stdout: `${headSha}\n`, stderr: '', exitCode: 0 };
    }
    if (ignoredPaths && command.startsWith('check-ignore -- ')) {
      const ignored = ignoredPaths.filter((path) => command.includes(`'${path}'`));
      return {
        stdout: ignored.map((path) => `${path}\n`).join(''),
        stderr: '',
        exitCode: ignored.length ? 0 : 1,
      };
    }
    throw new Error(`Unexpected git probe: ${command}`);
  };
}

function issuesReview(reviewedHeadSha: string): ReviewStatus {
  return {
    reviewerSessionId: 'fixture-session-' + 'review-1',
    mode: 'cold' as const,
    id: 'review-1',
    source: 'human-gate',
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 1,
    reviewedHeadSha,
    artifactPaths: ['artifacts/review-loop-1/review.diff', 'artifacts/review-loop-1/review.md'],
  };
}

test('independent publication review refuses a dirty slot with a commit action', async () => {
  await assert.rejects(
    assertReviewLaunchState(
      [],
      gitExecutor(' M services/gateway/src/run-engine/ready-gate.ts\n?? scratch.txt\n', 'abc123'),
    ),
    (error: unknown) => {
      const envelope = error as {
        code?: string;
        message?: string;
        userAction?: string;
        details?: { dirtyPathCount?: number; dirtyPaths?: string[] };
      };
      assert.equal(envelope.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
      assert.match(envelope.message ?? '', /dirty tree.*2 uncommitted path/iu);
      assert.match(envelope.userAction ?? '', /git status.*git commit/iu);
      assert.equal(envelope.details?.dirtyPathCount, 2);
      assert.deepEqual(envelope.details?.dirtyPaths, [
        ' M services/gateway/src/run-engine/ready-gate.ts',
        '?? scratch.txt',
      ]);
      return true;
    },
  );
});

test('independent publication re-review refuses the same HEAD after issues', async () => {
  await assert.rejects(
    assertReviewLaunchState([issuesReview('abc123')], gitExecutor('', 'abc123')),
    (error: unknown) => {
      const envelope = error as {
        code?: string;
        message?: string;
        userAction?: string;
        details?: { priorReviewCommit?: string; priorFeedbackPath?: string };
      };
      assert.equal(envelope.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
      assert.match(envelope.message ?? '', /prior issues review.*abc123/iu);
      assert.match(envelope.message ?? '', /review-loop-1\/review\.md/u);
      assert.match(envelope.userAction ?? '', /fix.*git commit.*new HEAD/iu);
      assert.equal(envelope.details?.priorReviewCommit, 'abc123');
      assert.ok(envelope.details?.priorFeedbackPath);
      return true;
    },
  );
});

const EVIDENCE_POINTER = 'temp/tasks/fix/task-1/artifacts/latest-valid-recipe-run.json';

/** The warm delta review shape left at a publish gate after an evidence-only finding. */
function warmEvidenceFindingReview(file = EVIDENCE_POINTER): ReviewStatus {
  return {
    ...issuesReview('abc123'),
    mode: 'warm',
    reviewedReviewSubjectHash: 'subject-before-refresh',
    reviewSnapshot: {
      source: 'local-git',
      baseRef: 'origin/main',
      baseSha: 'abc123',
      headSha: 'abc123',
      diffHash: 'empty-delta',
      capturedAt: '2026-10-30T08:26:50.252Z',
    },
    session: {
      mode: 'warm',
      continuity: 'resumed',
      reviewId: 'review-1',
      sessionId: 'fixture-session-review-1',
      lastReviewedHeadSha: 'abc123',
    },
    issues: [
      { file, line: 1, severity: 'minor', description: 'R1: selected run is not canonical' },
    ],
  };
}

function refreshedPackage(reviewSubjectHash = 'subject-after-refresh') {
  return {
    headSha: 'abc123',
    reviewSubjectHash,
    reviewSnapshot: {
      source: 'local-git' as const,
      baseRef: 'origin/main',
      baseSha: 'base000',
      headSha: 'abc123',
      diffHash: 'full-contribution',
      capturedAt: '2026-10-30T12:10:35.742Z',
    },
  };
}

test('independent publication re-review allows the same HEAD after an evidence-only refresh', async () => {
  await assert.doesNotReject(
    assertReviewLaunchState(
      [warmEvidenceFindingReview()],
      gitExecutor('', 'abc123', [EVIDENCE_POINTER]),
      refreshedPackage(),
    ),
  );
});

test('independent publication re-review refuses the same HEAD when a finding names versioned source', async () => {
  await assert.rejects(
    assertReviewLaunchState(
      [warmEvidenceFindingReview('app/components/Perps/usePerpsMemory.ts')],
      gitExecutor('', 'abc123', [EVIDENCE_POINTER]),
      refreshedPackage(),
    ),
    /prior issues review already examined commit abc123/u,
  );
});

test('independent publication re-review refuses the same HEAD when the evidence did not change', async () => {
  await assert.rejects(
    assertReviewLaunchState(
      [warmEvidenceFindingReview()],
      gitExecutor('', 'abc123'),
      refreshedPackage('subject-before-refresh'),
    ),
    /prior issues review already examined commit abc123/u,
  );
});

test('independent publication re-review allows a clean advanced HEAD', async () => {
  await assert.doesNotReject(
    assertReviewLaunchState([issuesReview('abc123')], gitExecutor('', 'def456')),
  );
});

test('independent publication re-review allows the same HEAD after fix retries are exhausted', async () => {
  const review = issuesReview('abc123');
  review.retryCount = 3;
  review.maxRetries = 3;
  review.maxRetriesExhausted = true;
  review.feedbackSent = false;
  review.recoveryContinuationPending = true;
  review.issues = [{ file: 'src/example.ts', description: 'still broken' }];
  await assert.doesNotReject(assertReviewLaunchState([review], gitExecutor('', 'abc123')));
});

test('independent publication continuation can deliver pending findings at the same HEAD', async () => {
  const review = issuesReview('abc123');
  review.feedbackSent = false;
  review.recoveryContinuationPending = true;
  review.issues = [{ file: 'src/example.ts', description: 'Fix the pending finding' }];
  await assert.doesNotReject(assertReviewLaunchState([review], gitExecutor('', 'abc123')));
});

test('independent publication re-review trusts the immutable snapshot over a restamped compatibility HEAD', async () => {
  const review = issuesReview('def456');
  review.reviewSnapshot = {
    source: 'local-git',
    headSha: 'abc123',
    capturedAt: '2026-08-03T00:00:00.000Z',
  };
  await assert.doesNotReject(assertReviewLaunchState([review], gitExecutor('', 'def456')));
});

test('independent publication review surfaces a recoverable non-zero git probe failure', async () => {
  await assert.rejects(
    assertReviewLaunchState([], async (command) => ({
      stdout: command.includes('rev-parse HEAD') ? 'abc123\n' : '',
      stderr: command.includes('status --porcelain') ? 'not a git worktree' : '',
      exitCode: command.includes('status --porcelain') ? 128 : 0,
    })),
    (error: unknown) => {
      const rejection = publicationReviewLaunchRejectionFromError(error);
      assert.equal(rejection?.code, 'PUBLICATION_REVIEW_GIT_PROBE_FAILED');
      assert.match(rejection?.message ?? '', /git status failed \(exit 128\)/u);
      assert.match(rejection?.userAction ?? '', /git status.*git rev-parse HEAD/iu);
      assert.equal(
        (rejection?.details as { currentHeadSha?: string } | undefined)?.currentHeadSha,
        'abc123',
      );
      return true;
    },
  );
});

test('independent publication review surfaces a recoverable thrown git transport failure', async () => {
  await assert.rejects(
    assertReviewLaunchState([], async () => {
      throw new Error(`node disconnected ${'x'.repeat(2_000)}`);
    }),
    (error: unknown) => {
      const rejection = publicationReviewLaunchRejectionFromError(error);
      assert.equal(rejection?.code, 'PUBLICATION_REVIEW_GIT_PROBE_FAILED');
      assert.match(rejection?.message ?? '', /could not run/u);
      const details = rejection?.details as { cause?: string } | undefined;
      assert.match(details?.cause ?? '', /truncated/u);
      return true;
    },
  );
});

test('independent publication review surfaces a recoverable empty HEAD probe failure', async () => {
  await assert.rejects(assertReviewLaunchState([], gitExecutor('', '')), (error: unknown) => {
    const rejection = publicationReviewLaunchRejectionFromError(error);
    assert.equal(rejection?.code, 'PUBLICATION_REVIEW_GIT_PROBE_FAILED');
    assert.match(rejection?.message ?? '', /returned no commit/u);
    assert.match(rejection?.userAction ?? '', /valid commit.*git rev-parse HEAD/iu);
    return true;
  });
});
