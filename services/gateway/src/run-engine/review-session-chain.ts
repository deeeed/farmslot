import {
  isTerminalRunStatus,
  parseGitHubRef,
  type ReviewSessionRefusalReason,
  type ReviewSessionTrace,
  type Run,
} from '@farmslot/protocol';

import { primaryReviewedHeadForSession } from '../review/session-mode.js';
import {
  runnerRetainedSessionHandoff,
  runnerSupportsNativeTaskReuse,
} from '../runners/registry.js';
import {
  deliverPromptToRetainedRunnerSession,
  type RunnerSessionReactivationOptions,
} from '../runners/session-reactivation.js';

export interface RepeatReviewResumeBinding {
  reviewId: string;
  priorRunId: string;
  contextId: string;
  runnerSessionId: string;
  runnerSessionPath: string;
  repository: string;
  prNumber: number;
  lastReviewedHeadSha: string;
}

export type RepeatReviewResumePlan =
  | { kind: 'fresh' }
  | { kind: 'resume'; binding: RepeatReviewResumeBinding }
  | { kind: 'native-resume'; binding: Omit<RepeatReviewResumeBinding, 'runnerSessionPath'> }
  | { kind: 'refused'; reason: ReviewSessionRefusalReason };

export type RepeatReviewResumeAttempt =
  | {
      kind: 'resumed';
      plan: Extract<RepeatReviewResumePlan, { kind: 'resume' }>;
      trace: ReviewSessionTrace;
    }
  | {
      kind: 'refused';
      plan: { kind: 'refused'; reason: 'session-unavailable' };
      reason: string;
    }
  | { kind: 'hold'; plan: Extract<RepeatReviewResumePlan, { kind: 'resume' }>; reason: string };

/**
 * Resolve cross-generation reviewer continuity from persisted run facts only.
 * Runner mechanics remain behind the shared runner capability adapter.
 */
export function resolveRepeatReviewResumePlan(
  current: Pick<
    Run,
    | 'flowType'
    | 'project'
    | 'slotId'
    | 'repeatReviewContext'
    | 'prWork'
    | 'transport'
    | 'nativeOwnerPrincipalId'
    | 'ticketOrPr'
  >,
  prior: Run | null,
  runner: string,
  model?: string | null,
  effort?: string | null,
): RepeatReviewResumePlan {
  const context = current.repeatReviewContext;
  if (context?.mode !== 'warm') return { kind: 'fresh' };
  const reviewId = context.session?.reviewId;
  if (!reviewId) return { kind: 'refused', reason: 'missing-session' };
  const native = current.transport === 'native';
  if (
    native
      ? !runnerSupportsNativeTaskReuse(runner)
      : runnerRetainedSessionHandoff(runner) !== 'resume-with-prompt'
  ) {
    return { kind: 'refused', reason: 'unsupported-runner' };
  }
  if (
    !prior ||
    prior.id !== context.priorRunId ||
    prior.flowType !== 'review-pr' ||
    current.flowType !== 'review-pr' ||
    !isTerminalRunStatus(prior.status) ||
    prior.project !== current.project
  ) {
    return { kind: 'refused', reason: 'missing-session' };
  }
  const requested = current.prWork?.review;
  if (
    requested &&
    (prior.prWork?.kind !== 'review' ||
      prior.prWork.review?.ownerId !== requested.ownerId ||
      prior.prWork.review.profile !== requested.profile)
  )
    return { kind: 'refused', reason: 'missing-session' };
  const currentRef = current.prWork?.pr ?? parseGitHubRef(current.ticketOrPr);
  const priorRef = prior.prWork?.pr ?? parseGitHubRef(prior.ticketOrPr);
  if (
    !currentRef ||
    currentRef.repo.toLowerCase() !== context.repository.toLowerCase() ||
    currentRef.number !== context.prNumber
  )
    return { kind: 'refused', reason: 'pr-mismatch' };
  if (
    !priorRef ||
    priorRef.repo.toLowerCase() !== context.repository.toLowerCase() ||
    priorRef.number !== context.prNumber ||
    context.chainId !== (prior.repeatReviewContext?.chainId ?? prior.id)
  ) {
    return { kind: 'refused', reason: 'pr-mismatch' };
  }
  if (!current.slotId || prior.slotId !== current.slotId) {
    return { kind: 'refused', reason: 'slot-mismatch' };
  }
  if (
    native &&
    (prior.transport !== 'native' ||
      !current.nativeOwnerPrincipalId ||
      prior.nativeOwnerPrincipalId !== current.nativeOwnerPrincipalId)
  )
    return { kind: 'refused', reason: 'missing-session' };
  if (!native && prior.transport === 'native')
    return { kind: 'refused', reason: 'missing-session' };
  if (native) {
    const requestedRef = parseGitHubRef(current.ticketOrPr);
    if (
      !requestedRef ||
      requestedRef.repo.toLowerCase() !== context.repository.toLowerCase() ||
      requestedRef.number !== context.prNumber ||
      context.priorFamilyId !== prior.familyId
    )
      return { kind: 'refused', reason: 'missing-session' };
  }
  const reviewer = [...(prior.agentContexts ?? [])]
    .filter(
      (candidate) =>
        candidate.runId === prior.id &&
        candidate.status === 'complete' &&
        candidate.role === 'review' &&
        candidate.reviewId === reviewId &&
        candidate.runner === runner &&
        candidate.slotId === current.slotId &&
        candidate.runnerSessionId?.trim() &&
        (native
          ? candidate.nativeSession?.generation &&
            candidate.nativeSession.acceptedAt &&
            !candidate.nativeSession.releasedAt &&
            !candidate.nativeSession.recovery
          : candidate.runnerSessionPath?.trim()),
    )
    .sort((left, right) => {
      const leftAt = left.completedAt ?? left.updatedAt ?? left.startedAt ?? '';
      const rightAt = right.completedAt ?? right.updatedAt ?? right.startedAt ?? '';
      return rightAt.localeCompare(leftAt) || right.id.localeCompare(left.id);
    })[0];
  if (!reviewer?.runnerSessionId?.trim() || (!native && !reviewer.runnerSessionPath?.trim())) {
    const anotherRunner = (prior.agentContexts ?? []).some(
      (candidate) => candidate.role === 'review' && candidate.runner !== runner,
    );
    return {
      kind: 'refused',
      reason: anotherRunner ? 'runner-mismatch' : 'missing-session',
    };
  }
  if (model && reviewer.model !== model) return { kind: 'refused', reason: 'model-mismatch' };
  if ((effort ?? null) !== (reviewer.effort ?? null))
    return { kind: 'refused', reason: 'effort-mismatch' };
  const reviewedHead = context.priorReviewedHeadSha;
  const headProvenance =
    primaryReviewedHeadForSession(prior, {
      reviewId,
      runnerSessionId: reviewer.runnerSessionId,
      repository: context.repository,
      prNumber: context.prNumber,
    }) === reviewedHead ||
    prior.decisions?.some((decision) => {
      const payload = decision.payload as
        | {
            kind?: string;
            repo?: string;
            prNumber?: number;
            reviewSnapshot?: { headSha?: string | null };
          }
        | undefined;
      return (
        payload?.kind === 'review' &&
        payload.repo?.toLowerCase() === context.repository.toLowerCase() &&
        payload.prNumber === context.prNumber &&
        payload.reviewSnapshot?.headSha === reviewedHead
      );
    }) ||
    prior.engineState?.publishGate?.reviews?.some(
      (review) =>
        review.reviewerSessionId === reviewer.runnerSessionId &&
        review.reviewedHeadSha === reviewedHead &&
        ['pass', 'issues'].includes(review.verdict),
    );
  if (!reviewedHead || !context.currentHeadSha || !headProvenance)
    return { kind: 'refused', reason: 'missing-session' };
  if (native)
    return {
      kind: 'native-resume',
      binding: {
        reviewId,
        repository: context.repository,
        prNumber: context.prNumber,
        lastReviewedHeadSha: reviewedHead,
        priorRunId: prior.id,
        contextId: reviewer.id,
        runnerSessionId: reviewer.runnerSessionId,
      },
    };
  return {
    kind: 'resume',
    binding: {
      reviewId,
      repository: context.repository,
      prNumber: context.prNumber,
      lastReviewedHeadSha: reviewedHead,
      priorRunId: prior.id,
      contextId: reviewer.id,
      runnerSessionId: reviewer.runnerSessionId,
      runnerSessionPath: reviewer.runnerSessionPath!,
    },
  };
}

/**
 * Execute one resolved repeat-review resume through the shared runner contract.
 * The workflow receives facts only; runner-specific mechanics stay in the adapter.
 */
export async function attemptRepeatReviewResume(
  plan: Extract<RepeatReviewResumePlan, { kind: 'resume' }>,
  runner: string,
  delivery: Omit<RunnerSessionReactivationOptions, 'runnerId' | 'sessionId' | 'sessionPath'>,
): Promise<RepeatReviewResumeAttempt> {
  const result = await deliverPromptToRetainedRunnerSession({
    ...delivery,
    runnerId: runner,
    sessionId: plan.binding.runnerSessionId,
    sessionPath: plan.binding.runnerSessionPath,
  });
  if (result.delivered) {
    return {
      kind: 'resumed',
      plan,
      trace: {
        mode: 'warm',
        reviewId: plan.binding.reviewId,
        repository: plan.binding.repository,
        prNumber: plan.binding.prNumber,
        lastReviewedHeadSha: plan.binding.lastReviewedHeadSha,
        continuity: 'resumed',
        priorRunId: plan.binding.priorRunId,
        priorSessionId: plan.binding.runnerSessionId,
        sessionId: plan.binding.runnerSessionId,
      },
    };
  }
  if (result.disposition === 'safe-send') {
    return {
      kind: 'refused',
      plan: { kind: 'refused', reason: 'session-unavailable' },
      reason: result.reason,
    };
  }
  return { kind: 'hold', plan, reason: result.reason };
}
