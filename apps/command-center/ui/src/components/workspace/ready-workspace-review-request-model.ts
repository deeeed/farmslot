import type { Run } from '@farmslot/protocol';
import { publicationReviewBlockingReason } from '@farmslot/review-dispatch';

/** Publication review progress comes from accepted requests and current agent attempts. */
export function readyReviewRequestProgress(
  run: Pick<Run, 'status' | 'decisions' | 'agentContexts' | 'engineState'> | null | undefined,
): string {
  if (!run || ['done', 'failed', 'cancelled'].includes(run.status)) return '';
  const reviewBlock = publicationReviewBlockingReason(run);
  if (reviewBlock) return reviewBlock;
  const request = [...run.decisions]
    .reverse()
    .find((decision) => decision.type === 'engine_human_gate');
  if (!request || request.resolvedAction !== 'request-review') return '';
  if (!request?.resolvedAt) return '';
  const gate = run.engineState?.publishGate;
  const contexts = (run.agentContexts ?? []).filter(
    (context) =>
      ['review', 'review-fix'].includes(context.role) &&
      (['launching', 'working', 'waiting'].includes(context.status) ||
        (context.attemptStartedAt ?? '') >= request.resolvedAt!),
  );
  const active = contexts.find((context) =>
    ['launching', 'working', 'waiting'].includes(context.status),
  );
  if (active) {
    const runner = active.runner || 'reviewer';
    if (active.status === 'launching')
      return `Starting ${runner} review; waiting for prompt acceptance.`;
    if (active.role === 'review-fix') return 'Worker is fixing review findings.';
    return active.status === 'waiting'
      ? `${runner} review is waiting.`
      : `${runner} review is running.`;
  }
  if (gate?.reviewLaunchRejection) return gate.reviewLaunchRejection.message;
  if (gate?.reviewSequence?.length) {
    return contexts.some((context) => context.status === 'complete')
      ? 'Review finished; preparing the next review or refreshing the publication package.'
      : 'Review requested; preparing the reviewer.';
  }
  return request.context?.reviewRequestConsumedAt
    ? ''
    : 'Review requested; waiting for processing.';
}
