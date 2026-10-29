export class TerminalReviewArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalReviewArtifactError';
  }
}

export class ReviewerExitedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReviewerExitedError';
  }
}

export function reviewerExitForNativeSnapshot(
  snapshot: NativeSessionReadResult,
  cause?: unknown,
): ReviewerExitedError | undefined {
  const session = snapshot.session;
  if (
    ['closed', 'failed'].includes(session.state) &&
    (session.processStopped || !session.processPid)
  )
    return new ReviewerExitedError(
      session.error ?? 'Native reviewer stopped without a valid terminal signal',
      { cause },
    );
  return undefined;
}

/** An uncertain dispatch becomes an exit only after an ownership-checked stop observation. */
export async function nativeReviewerFailure(
  error: unknown,
  readSnapshot: () => Promise<NativeSessionReadResult>,
): Promise<unknown> {
  if (!(error instanceof NativeWorkerOperationUncertainError)) return error;
  let snapshot: NativeSessionReadResult;
  try {
    snapshot = await readSnapshot();
  } catch (observationError) {
    return new NativeWorkerOperationUncertainError(
      error.operation,
      error.message,
      new AggregateError([error, observationError], 'Native reviewer launch observation failed'),
    );
  }
  return reviewerExitForNativeSnapshot(snapshot, error) ?? error;
}

/** The launch or delivery outcome is unknown, so the reviewer may still be running. */
export function isUncertainReviewerOperation(error: unknown): boolean {
  return (
    error instanceof NativeWorkerOperationUncertainError ||
    error instanceof PromptDeliveryUncertainError
  );
}

export function isTerminalReviewArtifactError(
  error: unknown,
): error is TerminalReviewArtifactError {
  return error instanceof TerminalReviewArtifactError;
}

/** A provider capacity refusal has no review verdict; the operator can request it again. */
export function isReviewerCapacityError(error: unknown): boolean {
  return error instanceof Error && /\bselected model is at capacity\b/iu.test(error.message);
}

export function isSuccessfulTerminalReviewSignal(
  signal: { status: string } | null | undefined,
): boolean {
  return signal?.status === 'complete' || signal?.status === 'done';
}

export function terminalReviewArtifactErrorForCompletion(
  reviewerContextId: string,
  terminalInvalidReason: string | undefined,
): TerminalReviewArtifactError | undefined {
  if (!terminalInvalidReason) return undefined;
  return new TerminalReviewArtifactError(
    `Reviewer ${reviewerContextId} completed with an invalid result artifact: ${terminalInvalidReason}`,
  );
}
import path from 'node:path';

import type { NativeSessionReadResult, ReviewAttempt, ReviewStatus } from '@farmslot/protocol';

import { NativeWorkerOperationUncertainError } from '../runners/native/worker-error.js';
import { PromptDeliveryUncertainError } from '../runners/registry.js';

/** The structured reviewer result that a gateway-accepted fix extends without a new turn. */
export function acceptedReviewFixPredecessor(review: ReviewStatus): ReviewAttempt | undefined {
  const fix = review.attempts?.at(-1);
  const prior = review.attempts?.at(-2);
  const snapshot = review.reviewSnapshot;
  const priorSnapshot = prior?.reviewSnapshot;
  return review.verdict === 'pass' &&
    review.unresolvedCount === 0 &&
    fix?.verdict === 'pass' &&
    fix.unresolvedCount === 0 &&
    !fix.session &&
    fix.timeline?.some((segment) => segment.kind === 'worker-fix' && segment.verdict === 'pass') &&
    fix.fixDelta?.source === 'local-git' &&
    snapshot?.source === 'local-git' &&
    priorSnapshot?.source === 'local-git' &&
    fix.fixDelta.fixBaseSha === priorSnapshot.headSha &&
    fix.fixDelta.fixHeadSha === snapshot.headSha &&
    priorSnapshot.baseRef === snapshot.baseRef &&
    priorSnapshot.baseSha === snapshot.baseSha
    ? prior
    : undefined;
}

/** Read the attempt whose verdict is projected; a later blocked fix is audit history. */
export function reviewResultArtifactPath(
  review: Pick<ReviewStatus, 'attempts' | 'artifactPaths' | 'completedAt'>,
): string | undefined {
  const attempt =
    (review.completedAt
      ? review.attempts
          ?.slice()
          .reverse()
          .find((entry) => entry.completedAt === review.completedAt)
      : undefined) ?? review.attempts?.at(-1);
  return (attempt?.artifactPaths ?? review.artifactPaths)
    ?.slice()
    .reverse()
    .find(
      (entry) =>
        entry.startsWith('artifacts/') &&
        !entry.split('/').includes('..') &&
        path.posix.basename(entry) === 'review-result.json',
    );
}
