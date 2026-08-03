import type {
  ExecResult,
  IndependentReviewStatus,
  PublicationReviewLaunchRejection,
} from '@farmslot/protocol';

import { GatewayMethodError } from '../core/method-error.js';

type GitExecutor = (command: string) => Promise<ExecResult>;

export interface IndependentReviewLaunchState {
  dirtyPathCount: number;
  headSha: string;
}

function isRecoverableReviewLaunchCode(
  code: string,
): code is PublicationReviewLaunchRejection['code'] {
  return (
    code === 'PUBLICATION_REVIEW_LAUNCH_REJECTED' || code === 'PUBLICATION_REVIEW_GIT_PROBE_FAILED'
  );
}

export function publicationReviewLaunchRejectionFromError(
  error: unknown,
): PublicationReviewLaunchRejection | null {
  if (
    !(error instanceof GatewayMethodError) ||
    !isRecoverableReviewLaunchCode(error.code) ||
    !error.userAction
  ) {
    return null;
  }
  return {
    code: error.code,
    message: error.message,
    userAction: error.userAction,
    details: error.details,
    rejectedAt: new Date().toISOString(),
  };
}

function assertGitProbe(result: ExecResult, probe: string): void {
  if (result.exitCode === 0) return;
  throw new GatewayMethodError(
    'PUBLICATION_REVIEW_GIT_PROBE_FAILED',
    `Cannot verify the slot worktree before independent review: ${probe} failed (exit ${result.exitCode})`,
    {
      userAction:
        'Run `git status --short` and `git rev-parse HEAD` in the slot worktree, repair the git state, then request the review again.',
      details: { probe, stderr: result.stderr, stdout: result.stdout },
    },
  );
}

function latestIndependentReview(
  reviews: readonly IndependentReviewStatus[],
): IndependentReviewStatus | undefined {
  return reviews.filter((review) => review.source !== 'self-review').at(-1);
}

/**
 * Fail closed before an independent publication review can consume another
 * reviewer session. The caller supplies the slot git executor so this policy
 * is shared by automatic launches and synchronous decision resolution.
 */
export async function assertIndependentReviewLaunchState(
  reviews: readonly IndependentReviewStatus[],
  executeGit: GitExecutor,
): Promise<IndependentReviewLaunchState> {
  const [status, head] = await Promise.all([
    executeGit('status --porcelain=v1 --untracked-files=all'),
    executeGit('rev-parse HEAD'),
  ]);
  assertGitProbe(status, 'git status');
  assertGitProbe(head, 'git rev-parse HEAD');

  const dirtyPathCount = status.stdout.split(/\r?\n/u).filter(Boolean).length;
  const headSha = head.stdout.trim();
  if (!headSha) {
    throw new GatewayMethodError(
      'PUBLICATION_REVIEW_GIT_PROBE_FAILED',
      'Cannot verify the slot worktree before independent review: git rev-parse HEAD returned no commit',
      {
        userAction:
          'Create or restore a valid commit in the slot worktree, verify with `git rev-parse HEAD`, then request the review again.',
      },
    );
  }

  if (dirtyPathCount > 0) {
    throw new GatewayMethodError(
      'PUBLICATION_REVIEW_LAUNCH_REJECTED',
      `Independent review launch refused: the slot has a dirty tree with ${dirtyPathCount} uncommitted path(s); commit validated fixes before re-review.`,
      {
        userAction:
          'Inspect with `git status --short`, fix and validate the work, then run `git add <fixed-paths> && git commit -m "fix: address review findings"` before requesting re-review.',
        details: { dirtyPathCount, currentHeadSha: headSha },
      },
    );
  }

  const priorReview = latestIndependentReview(reviews);
  const reviewedCommit =
    priorReview?.reviewedHeadSha?.trim() || priorReview?.reviewSnapshot?.headSha?.trim();
  if (priorReview?.verdict === 'issues' && reviewedCommit === headSha) {
    const feedbackPath =
      priorReview.artifactPaths?.find((artifactPath) =>
        /(?:review-feedback|self-review)\.md$/u.test(artifactPath),
      ) ??
      priorReview.artifactPaths?.find((artifactPath) => artifactPath.endsWith('.md')) ??
      priorReview.taskProgressArtifactPath ??
      priorReview.artifactPaths?.[0] ??
      'the prior independent-review artifact';
    throw new GatewayMethodError(
      'PUBLICATION_REVIEW_LAUNCH_REJECTED',
      `Independent review launch refused: the prior issues review already examined commit ${reviewedCommit}. Prior feedback: ${feedbackPath}.`,
      {
        userAction: `Fix the findings in ${feedbackPath}, validate them, then run \`git add <fixed-paths> && git commit -m "fix: address review findings"\` and request re-review at a new HEAD.`,
        details: {
          currentHeadSha: headSha,
          priorReviewCommit: reviewedCommit,
          priorFeedbackPath: feedbackPath,
        },
      },
    );
  }

  return { dirtyPathCount, headSha };
}
