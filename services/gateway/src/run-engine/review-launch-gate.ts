import type {
  ExecResult,
  IndependentReviewStatus,
  PublicationReviewLaunchRejection,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { shellQuote } from '../core/tmux.js';

type GitExecutor = (command: string) => Promise<ExecResult>;

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

function truncateProbeOutput(value: string, maxLength = 1_000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n… truncated`;
}

function assertGitProbe(
  result: ExecResult,
  probe: string,
  details: Record<string, unknown> = {},
): void {
  if (result.exitCode === 0) return;
  throw new GatewayMethodError(
    'PUBLICATION_REVIEW_GIT_PROBE_FAILED',
    `Cannot verify the slot worktree before independent review: ${probe} failed (exit ${result.exitCode})`,
    {
      userAction:
        'Run `git status --short` and `git rev-parse HEAD` in the slot worktree, repair the git state, then request the review again.',
      details: {
        ...details,
        probe,
        stderr: truncateProbeOutput(result.stderr),
        stdout: truncateProbeOutput(result.stdout),
      },
    },
  );
}

async function executeGitProbe(executeGit: GitExecutor, command: string, probe: string) {
  try {
    return await executeGit(command);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayMethodError(
      'PUBLICATION_REVIEW_GIT_PROBE_FAILED',
      `Cannot verify the slot worktree before independent review: ${probe} could not run`,
      {
        userAction:
          'Restore slot and node connectivity, then run `git status --short` and `git rev-parse HEAD` in the slot worktree before requesting the review again.',
        details: { probe, cause: truncateProbeOutput(message) },
      },
    );
  }
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
): Promise<void> {
  const [status, head] = await Promise.all([
    executeGitProbe(executeGit, 'status --porcelain=v1 --untracked-files=all', 'git status'),
    executeGitProbe(executeGit, 'rev-parse HEAD', 'git rev-parse HEAD'),
  ]);
  assertGitProbe(head, 'git rev-parse HEAD');

  const dirtyPaths = status.stdout.split(/\r?\n/u).filter(Boolean);
  const dirtyPathCount = dirtyPaths.length;
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
  assertGitProbe(status, 'git status', { currentHeadSha: headSha });

  if (dirtyPathCount > 0) {
    throw new GatewayMethodError(
      'PUBLICATION_REVIEW_LAUNCH_REJECTED',
      `Independent review launch refused: the slot has a dirty tree with ${dirtyPathCount} uncommitted path(s); commit validated fixes before re-review.`,
      {
        userAction:
          'Inspect with `git status --short`, fix and validate the work, then run `git add <fixed-paths> && git commit -m "fix: address review findings"` before requesting re-review.',
        details: {
          dirtyPathCount,
          dirtyPaths: dirtyPaths
            .slice(0, 10)
            .map((dirtyPath) => truncateProbeOutput(dirtyPath, 300)),
          currentHeadSha: headSha,
        },
      },
    );
  }

  const priorReview = latestIndependentReview(reviews);
  const reviewedCommit =
    priorReview?.reviewSnapshot?.headSha?.trim() || priorReview?.reviewedHeadSha?.trim();
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
}

export async function assertIndependentReviewLaunchStateForSlot(
  reviews: readonly IndependentReviewStatus[],
  slotId: string,
): Promise<void> {
  try {
    const vars = await loadSlotVars(slotId);
    await assertIndependentReviewLaunchState(reviews, (command) =>
      execOnSlot(vars, `git -C ${shellQuote(vars.remoteRepo)} ${command}`, { timeout: 15_000 }),
    );
  } catch (error) {
    if (error instanceof GatewayMethodError && isRecoverableReviewLaunchCode(error.code)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayMethodError(
      'PUBLICATION_REVIEW_GIT_PROBE_FAILED',
      'Cannot verify the slot worktree before independent review: slot git probes could not start',
      {
        userAction:
          'Restore the slot and node connection, verify the worktree with `git status --short` and `git rev-parse HEAD`, then request the review again.',
        details: { cause: truncateProbeOutput(message) },
      },
    );
  }
}
