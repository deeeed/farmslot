import {
  isTerminalRunStatus,
  parseGitHubRef,
  type ReviewSessionFallbackReason,
  type ReviewSessionTrace,
  type Run,
} from '@farmslot/protocol';

import { runnerRetainedSessionHandoff } from '../runners/registry.js';
import {
  deliverPromptToRetainedRunnerSession,
  type RunnerSessionReactivationOptions,
} from '../runners/session-reactivation.js';

export interface RepeatReviewResumeBinding {
  priorRunId: string;
  contextId: string;
  runnerSessionId: string;
  runnerSessionPath: string;
}

export type RepeatReviewResumePlan =
  | { kind: 'reset' }
  | { kind: 'resume'; binding: RepeatReviewResumeBinding }
  | { kind: 'fallback'; reason: ReviewSessionFallbackReason };

export type RepeatReviewResumeAttempt =
  | { kind: 'not-resumed'; plan: Exclude<RepeatReviewResumePlan, { kind: 'resume' }> }
  | {
      kind: 'resumed';
      plan: Extract<RepeatReviewResumePlan, { kind: 'resume' }>;
      trace: ReviewSessionTrace;
    }
  | {
      kind: 'fallback';
      plan: { kind: 'fallback'; reason: 'session-unavailable' };
      reason: string;
    }
  | { kind: 'hold'; plan: Extract<RepeatReviewResumePlan, { kind: 'resume' }>; reason: string };

/**
 * Resolve cross-generation reviewer continuity from persisted run facts only.
 * Runner mechanics remain behind the shared runner capability adapter.
 */
export function resolveRepeatReviewResumePlan(
  current: Pick<Run, 'flowType' | 'project' | 'slotId' | 'repeatReviewContext'>,
  prior: Run | null,
  runner: string,
): RepeatReviewResumePlan {
  const context = current.repeatReviewContext;
  if (!context || context.sessionIntent !== 'resume') return { kind: 'reset' };
  if (runnerRetainedSessionHandoff(runner) !== 'resume-with-prompt') {
    return { kind: 'fallback', reason: 'unsupported-runner' };
  }
  if (
    !prior ||
    prior.id !== context.priorRunId ||
    prior.flowType !== 'review-pr' ||
    current.flowType !== 'review-pr' ||
    !isTerminalRunStatus(prior.status) ||
    prior.project !== current.project
  ) {
    return { kind: 'fallback', reason: 'missing-session' };
  }
  const priorRef = parseGitHubRef(prior.ticketOrPr);
  if (
    !priorRef ||
    priorRef.repo.toLowerCase() !== context.repository.toLowerCase() ||
    priorRef.number !== context.prNumber ||
    context.chainId !== (prior.repeatReviewContext?.chainId ?? prior.id)
  ) {
    return { kind: 'fallback', reason: 'missing-session' };
  }
  if (!current.slotId || prior.slotId !== current.slotId) {
    return { kind: 'fallback', reason: 'slot-mismatch' };
  }
  const reviewer = [...(prior.agentContexts ?? [])]
    .filter(
      (candidate) =>
        candidate.role === 'review' &&
        candidate.runner === runner &&
        candidate.slotId === current.slotId &&
        candidate.runnerSessionId?.trim() &&
        candidate.runnerSessionPath?.trim(),
    )
    .sort((left, right) => {
      const leftAt = left.completedAt ?? left.updatedAt ?? left.startedAt ?? '';
      const rightAt = right.completedAt ?? right.updatedAt ?? right.startedAt ?? '';
      return rightAt.localeCompare(leftAt) || right.id.localeCompare(left.id);
    })[0];
  if (!reviewer?.runnerSessionId?.trim() || !reviewer.runnerSessionPath?.trim()) {
    const anotherRunner = (prior.agentContexts ?? []).some(
      (candidate) => candidate.role === 'review' && candidate.runner !== runner,
    );
    return {
      kind: 'fallback',
      reason: anotherRunner ? 'runner-mismatch' : 'missing-session',
    };
  }
  return {
    kind: 'resume',
    binding: {
      priorRunId: prior.id,
      contextId: reviewer.id,
      runnerSessionId: reviewer.runnerSessionId,
      runnerSessionPath: reviewer.runnerSessionPath,
    },
  };
}

/**
 * Resolve and execute one repeat-review resume through the shared runner contract.
 * The workflow receives facts only; runner-specific mechanics stay in the adapter.
 */
export async function attemptRepeatReviewResume(
  current: Pick<Run, 'flowType' | 'project' | 'slotId' | 'repeatReviewContext'>,
  prior: Run | null,
  runner: string,
  delivery: Omit<RunnerSessionReactivationOptions, 'runnerId' | 'sessionId' | 'sessionPath'>,
): Promise<RepeatReviewResumeAttempt> {
  const plan = resolveRepeatReviewResumePlan(current, prior, runner);
  if (plan.kind !== 'resume') return { kind: 'not-resumed', plan };
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
        intent: 'resume',
        continuity: 'resumed',
        priorRunId: plan.binding.priorRunId,
        priorSessionId: plan.binding.runnerSessionId,
        sessionId: plan.binding.runnerSessionId,
      },
    };
  }
  if (result.disposition === 'safe-send') {
    return {
      kind: 'fallback',
      plan: { kind: 'fallback', reason: 'session-unavailable' },
      reason: result.reason,
    };
  }
  return { kind: 'hold', plan, reason: result.reason };
}
