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

/** Cleanup has settled before retrying; all other failures retain their existing handling. */
export async function withReviewerRelaunch<T>(
  review: () => Promise<T>,
  onRelaunch: (error: ReviewerExitedError) => void | Promise<void>,
): Promise<T> {
  try {
    return await review();
  } catch (error) {
    if (!(error instanceof ReviewerExitedError)) throw error;
    await onRelaunch(error);
    return review();
  }
}

export function isTerminalReviewArtifactError(
  error: unknown,
): error is TerminalReviewArtifactError {
  return error instanceof TerminalReviewArtifactError;
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

import type { NativeSessionReadResult, ReviewStatus } from '@farmslot/protocol';

import { NativeWorkerOperationUncertainError } from '../runners/native/worker-error.js';
import { PromptDeliveryUncertainError } from '../runners/registry.js';

/** The final native attempt is the sole structured verdict used for publication. */
export function reviewResultArtifactPath(
  review: Pick<ReviewStatus, 'attempts' | 'artifactPaths'>,
): string | undefined {
  return (review.attempts?.at(-1)?.artifactPaths ?? review.artifactPaths)
    ?.slice()
    .reverse()
    .find(
      (entry) =>
        entry.startsWith('artifacts/') &&
        !entry.split('/').includes('..') &&
        path.posix.basename(entry) === 'review-result.json',
    );
}
