export class TerminalReviewArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalReviewArtifactError';
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
  completionEstablished: boolean,
): TerminalReviewArtifactError | undefined {
  if (!completionEstablished || !terminalInvalidReason) return undefined;
  return new TerminalReviewArtifactError(
    `Reviewer ${reviewerContextId} completed with an invalid result artifact: ${terminalInvalidReason}`,
  );
}
