export class TerminalReviewArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalReviewArtifactError';
  }
}

export class ReviewerExitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewerExitedError';
  }
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
