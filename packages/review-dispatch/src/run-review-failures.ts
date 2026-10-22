import type { AgentContext, Run, RunStep } from '@farmslot/protocol';

export const recoveredReviewFailureColor = '#f59e0b';

export function reviewAttemptFailureReason(run: Run, context: AgentContext): string | null {
  if (context.error) return context.error;
  const settled = Object.entries(run.reviewRoundSettlements ?? {}).find(([key]) => {
    const identity: unknown = JSON.parse(key);
    return (
      Array.isArray(identity) &&
      identity[0] === context.reviewId &&
      identity[1] === context.reviewLoopNumber &&
      (!identity[2] ||
        identity[2] === context.startedAt ||
        identity[2] === context.attemptStartedAt)
    );
  });
  if (settled) return settled[1].reason;
  const replacement = run.agentContexts?.find(
    (candidate) =>
      candidate.id !== context.id &&
      candidate.role === 'review' &&
      candidate.reviewId === context.reviewId &&
      candidate.reviewLoopNumber === context.reviewLoopNumber &&
      candidate.reviewFallback &&
      (candidate.startedAt ?? '') >= (context.startedAt ?? ''),
  );
  return replacement?.reviewFallback?.detail ?? null;
}

/** A failed attempt remains visible after continuation instead of disappearing into a pending gap. */
export function runRecoveredReviewFailures(run: Run): Array<RunStep & { reason: string }> {
  const contexts = run.agentContexts ?? [];
  return contexts
    .filter(
      (context) =>
        context.role === 'review' &&
        context.status === 'failed' &&
        contexts.some(
          (later) =>
            later.id !== context.id &&
            later.role === 'review' &&
            later.reviewId === context.reviewId &&
            (later.startedAt ?? '') >= (context.startedAt ?? '') &&
            ['working', 'waiting', 'complete'].includes(later.status),
        ),
    )
    .map((context) => {
      const reason =
        reviewAttemptFailureReason(run, context) ??
        'Reviewer attempt failed; the run continued with another attempt.';
      return {
        name: `recovered-review-${context.id}`,
        status: 'failed',
        reason,
        detail: reason,
        startedAt: context.startedAt,
        completedAt: context.completedAt,
        outputs: { verdict: 'issues', recoveredReviewFailure: true },
      };
    });
}
