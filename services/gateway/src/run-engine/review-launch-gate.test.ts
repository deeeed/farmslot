import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExecResult, IndependentReviewStatus } from '@farmslot/protocol';

import {
  assertIndependentReviewLaunchState,
  publicationReviewLaunchRejectionFromError,
} from './review-launch-gate.js';

function gitExecutor(status: string, headSha: string): (command: string) => Promise<ExecResult> {
  return async (command) => {
    if (command.includes('status --porcelain')) {
      return { stdout: status, stderr: '', exitCode: 0 };
    }
    if (command.includes('rev-parse HEAD')) {
      return { stdout: `${headSha}\n`, stderr: '', exitCode: 0 };
    }
    throw new Error(`Unexpected git probe: ${command}`);
  };
}

function issuesReview(reviewedHeadSha: string): IndependentReviewStatus {
  return {
    id: 'extra-review-1',
    source: 'human-gate',
    crossRunner: true,
    loopNumber: 1,
    verdict: 'issues',
    unresolvedCount: 1,
    reviewedHeadSha,
    artifactPaths: [
      'artifacts/extra-review-loop-1/review.diff',
      'artifacts/extra-review-loop-1/self-review.md',
    ],
  };
}

test('independent publication review refuses a dirty slot with a commit action', async () => {
  await assert.rejects(
    assertIndependentReviewLaunchState(
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
    assertIndependentReviewLaunchState([issuesReview('abc123')], gitExecutor('', 'abc123')),
    (error: unknown) => {
      const envelope = error as {
        code?: string;
        message?: string;
        userAction?: string;
        details?: { priorReviewCommit?: string; priorFeedbackPath?: string };
      };
      assert.equal(envelope.code, 'PUBLICATION_REVIEW_LAUNCH_REJECTED');
      assert.match(envelope.message ?? '', /prior issues review.*abc123/iu);
      assert.match(envelope.message ?? '', /extra-review-loop-1\/self-review\.md/u);
      assert.match(envelope.userAction ?? '', /fix.*git commit.*new HEAD/iu);
      assert.equal(envelope.details?.priorReviewCommit, 'abc123');
      assert.ok(envelope.details?.priorFeedbackPath);
      return true;
    },
  );
});

test('independent publication re-review allows a clean advanced HEAD', async () => {
  await assert.doesNotReject(
    assertIndependentReviewLaunchState([issuesReview('abc123')], gitExecutor('', 'def456')),
  );
});

test('independent publication re-review trusts the immutable snapshot over a restamped compatibility HEAD', async () => {
  const review = issuesReview('def456');
  review.reviewSnapshot = {
    source: 'local-git',
    headSha: 'abc123',
    capturedAt: '2026-08-03T00:00:00.000Z',
  };
  await assert.doesNotReject(
    assertIndependentReviewLaunchState([review], gitExecutor('', 'def456')),
  );
});

test('independent publication review surfaces a recoverable non-zero git probe failure', async () => {
  await assert.rejects(
    assertIndependentReviewLaunchState([], async (command) => ({
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
    assertIndependentReviewLaunchState([], async () => {
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
  await assert.rejects(
    assertIndependentReviewLaunchState([], gitExecutor('', '')),
    (error: unknown) => {
      const rejection = publicationReviewLaunchRejectionFromError(error);
      assert.equal(rejection?.code, 'PUBLICATION_REVIEW_GIT_PROBE_FAILED');
      assert.match(rejection?.message ?? '', /returned no commit/u);
      assert.match(rejection?.userAction ?? '', /valid commit.*git rev-parse HEAD/iu);
      return true;
    },
  );
});
