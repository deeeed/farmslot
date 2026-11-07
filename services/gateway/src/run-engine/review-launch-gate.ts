import {
  type ExecResult,
  openReviewFindingCount,
  PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES,
  type PublicationReviewLaunchRejection,
  type ReadyGatePrPackage,
  reviewFindingIsSettled,
  reviewFixRetriesExhausted,
  type ReviewStatus,
  type Run,
} from '@farmslot/protocol';

import { loadSlotVars } from '../core/config.js';
import { execOnSlot } from '../core/exec.js';
import { GatewayMethodError } from '../core/method-error.js';
import { shellQuote } from '../core/tmux.js';
import { readReviewedInputs, type ReviewedInputsFingerprint } from '../review/reviewed-inputs.js';

import { publicationReviewSubjectOnlyDrifted, reviewNeedsContinuation } from './gate-policy.js';

type GitExecutor = (command: string) => Promise<ExecResult>;
type LaunchPackage = Pick<ReadyGatePrPackage, 'headSha' | 'reviewSnapshot' | 'reviewSubjectHash'>;

interface ReviewEvidenceInputs {
  reviewed: string;
  current: ReviewedInputsFingerprint;
}

type EvidenceInputsReader = () => Promise<ReviewEvidenceInputs | null>;

function isRecoverableReviewLaunchCode(
  code: string,
): code is PublicationReviewLaunchRejection['code'] {
  return (
    code === PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.launchRejected ||
    code === PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.gitProbeFailed ||
    code === PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.roundLimitReached
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
    PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.gitProbeFailed,
    `Cannot verify the slot worktree before review: ${probe} failed (exit ${result.exitCode})`,
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
      PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.gitProbeFailed,
      `Cannot verify the slot worktree before review: ${probe} could not run`,
      {
        userAction:
          'Restore slot and node connectivity, then run `git status --short` and `git rev-parse HEAD` in the slot worktree before requesting the review again.',
        details: { probe, cause: truncateProbeOutput(message) },
      },
    );
  }
}

function latestLaunchReview(reviews: readonly ReviewStatus[]): ReviewStatus | undefined {
  // Failed/skipped records still occupy the launch slot, unlike protocol
  // latestReview which only considers pass/issues.
  return reviews.at(-1);
}

/**
 * A same-HEAD re-review has new input when the package refresh changed only the
 * evidence and every open finding names a path git ignores (run artifacts).
 */
async function refreshedEvidenceAnswersFindings(
  review: ReviewStatus,
  preparedPackage: LaunchPackage | undefined,
  executeGit: GitExecutor,
  readEvidenceInputs?: EvidenceInputsReader,
): Promise<boolean> {
  if (!preparedPackage) return false;
  const subjectDrift = publicationReviewSubjectOnlyDrifted(review, preparedPackage);
  const reviewedHead = review.reviewSnapshot?.headSha ?? review.reviewedHeadSha;
  if (
    !subjectDrift &&
    (review.reviewedReviewSubjectHash ||
      preparedPackage.headSha !== reviewedHead ||
      !readEvidenceInputs)
  )
    return false;
  const open = (review.issues ?? []).filter(
    (issue) => !reviewFindingIsSettled(review, review, issue),
  );
  if (!open.length || open.length !== openReviewFindingCount(review)) return false;
  const files = [...new Set(open.map((issue) => issue.file.trim()))];
  if (files.some((file) => !file)) return false;
  const ignored = await executeGitProbe(
    executeGit,
    `check-ignore -- ${files.map(shellQuote).join(' ')}`,
    'git check-ignore',
  );
  // check-ignore prints one line per ignored path. Reject source findings before scanning evidence.
  if (
    ignored.exitCode !== 0 ||
    ignored.stdout.split(/\r?\n/u).filter(Boolean).length !== files.length
  )
    return false;
  if (subjectDrift) return true;
  // Pipeline reviews precede packaging; use their last-issues input receipt.
  const inputs = await readEvidenceInputs?.();
  return (
    !!inputs &&
    inputs.current.fingerprint !== inputs.reviewed &&
    inputs.current.legacyFingerprint !== inputs.reviewed
  );
}

/**
 * Fail closed before an independent publication review can consume another
 * reviewer session. The caller supplies the slot git executor so this policy
 * is shared by automatic launches and synchronous decision resolution.
 */
export async function assertReviewLaunchState(
  reviews: readonly ReviewStatus[],
  executeGit: GitExecutor,
  preparedPackage?: LaunchPackage,
  readEvidenceInputs?: EvidenceInputsReader,
): Promise<void> {
  const [status, head] = await Promise.all([
    executeGitProbe(executeGit, 'status --porcelain=v1 --untracked-files=all', 'git status'),
    executeGitProbe(executeGit, 'rev-parse HEAD', 'git rev-parse HEAD'),
  ]);
  assertGitProbe(head, 'git rev-parse HEAD');

  const headSha = head.stdout.trim();
  if (!headSha) {
    throw new GatewayMethodError(
      PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.gitProbeFailed,
      'Cannot verify the slot worktree before review: git rev-parse HEAD returned no commit',
      {
        userAction:
          'Create or restore a valid commit in the slot worktree, verify with `git rev-parse HEAD`, then request the review again.',
      },
    );
  }
  assertGitProbe(status, 'git status', { currentHeadSha: headSha });
  const dirtyPaths = status.stdout.split(/\r?\n/u).filter(Boolean);
  const dirtyPathCount = dirtyPaths.length;

  if (dirtyPathCount > 0) {
    throw new GatewayMethodError(
      PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.launchRejected,
      `Review launch refused: the slot has a dirty tree with ${dirtyPathCount} uncommitted path(s); commit validated fixes before re-review.`,
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

  const priorReview = latestLaunchReview(reviews);
  const reviewedCommit =
    priorReview?.reviewSnapshot?.headSha?.trim() || priorReview?.reviewedHeadSha?.trim();
  if (
    priorReview?.verdict === 'issues' &&
    reviewedCommit === headSha &&
    !reviewNeedsContinuation(priorReview) &&
    !reviewFixRetriesExhausted(priorReview) &&
    !(await refreshedEvidenceAnswersFindings(
      priorReview,
      preparedPackage,
      executeGit,
      readEvidenceInputs,
    ))
  ) {
    const feedbackPath =
      priorReview.artifactPaths?.find((artifactPath) =>
        /(?:review-feedback|review)\.md$/u.test(artifactPath),
      ) ??
      priorReview.artifactPaths?.find((artifactPath) => artifactPath.endsWith('.md')) ??
      priorReview.taskProgressArtifactPath ??
      priorReview.artifactPaths?.[0] ??
      'the prior review artifact';
    throw new GatewayMethodError(
      PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.launchRejected,
      `Review launch refused: the prior issues review already examined commit ${reviewedCommit}. Prior feedback: ${feedbackPath}.`,
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

export async function assertReviewLaunchStateForSlot(
  reviews: readonly ReviewStatus[],
  slotId: string,
  preparedPackage?: LaunchPackage,
  run?: Run,
): Promise<void> {
  try {
    const vars = await loadSlotVars(slotId);
    await assertReviewLaunchState(
      reviews,
      (command) =>
        execOnSlot(vars, `git -C ${shellQuote(vars.remoteRepo)} ${command}`, { timeout: 15_000 }),
      preparedPackage,
      run
        ? async () => {
            const reviewed = run.engineState?.reviewedInputs?.rerunFor;
            if (!reviewed || reviewed !== run.engineState?.reviewInputsAtLaunch) return null;
            const current = await readReviewedInputs(run);
            return current ? { reviewed, current } : null;
          }
        : undefined,
    );
  } catch (error) {
    if (error instanceof GatewayMethodError && isRecoverableReviewLaunchCode(error.code)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayMethodError(
      PUBLICATION_REVIEW_LAUNCH_REJECTION_CODES.gitProbeFailed,
      'Cannot verify the slot worktree before review: slot git probes could not start',
      {
        userAction:
          'Restore the slot and node connection, verify the worktree with `git status --short` and `git rev-parse HEAD`, then request the review again.',
        details: { cause: truncateProbeOutput(message) },
      },
    );
  }
}
