// Review session policy: `fresh-per-pass` starts fresh runner reasoning;
// `warm-per-reviewer` lets the SAME reviewer session be
// resumed for re-reviews within ONE run's review loop. Warm reuse is scoped
// strictly to one run — same runId, task dir, artifact scope, runner, and
// review subject lineage — and a session is never reusable once its run
// completes, cancels, or releases its slot (it is deleted or kept only as a
// forensic-only record).
//
// The registry is process-local. Explicit continuation may recover a completed
// same-run reviewer from its persisted context and matching review result.

import {
  DEFAULT_REVIEW_SESSION_POLICY,
  isGateParkInFlightOrFreed,
  REVIEW_SESSION_POLICIES,
  type ReviewSessionIntent,
  type ReviewSessionPolicy,
  type Run,
} from '@farmslot/protocol';

export { DEFAULT_REVIEW_SESSION_POLICY, REVIEW_SESSION_POLICIES, type ReviewSessionPolicy };

export function parseReviewSessionPolicy(raw: unknown): ReviewSessionPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string' && (REVIEW_SESSION_POLICIES as string[]).includes(raw)) {
    return raw as ReviewSessionPolicy;
  }
  console.warn(
    `[self-review] invalid session_policy ${JSON.stringify(raw)} — using ${DEFAULT_REVIEW_SESSION_POLICY}`,
  );
  return undefined;
}

/**
 * Everything that must match EXACTLY for a warm reviewer session to be reused.
 * `subjectRef` is the review subject lineage (the run's branch): a run whose
 * subject changed must not inherit reviewer context from the old subject.
 */
export interface WarmReviewerScope {
  runId: string;
  taskDir: string;
  artifactScope: string | null;
  runner: string;
  subjectRef: string | null;
}

export interface WarmReviewerSession extends WarmReviewerScope {
  contextId: string;
  windowName: string;
  slotId: string;
  runnerSessionId: string;
  runnerSessionPath: string | null;
  lastLoopNumber: number;
  lastReviewedHeadSha: string | null;
  /** Kept for inspection only — a forensic session can never be claimed. */
  forensicOnly: boolean;
}

/**
 * Whether a pass may even LOOK for a resumable session. Pass 1 always cold-launches
 * (there is nothing to resume), and fresh-per-pass never resumes — preserving the
 * existing fresh-runner behavior for every loop.
 */
export function shouldAttemptWarmResume(
  policy: ReviewSessionPolicy,
  loopNumber: number,
  runnerSupportsReload: boolean,
): boolean {
  return policy === 'warm-per-reviewer' && loopNumber > 1 && runnerSupportsReload;
}

function sessionKey(runId: string, runner: string): string {
  return `${runId}::${runner}`;
}

const warmSessions = new Map<string, WarmReviewerSession>();

/** Record a reviewer session after a completed pass so the next loop can resume it. */
export function registerWarmReviewerSession(
  session: Omit<WarmReviewerSession, 'forensicOnly'>,
): void {
  if (!session.runnerSessionId.trim()) {
    throw new Error('warm reviewer session requires a runner session id');
  }
  warmSessions.set(sessionKey(session.runId, session.runner), {
    ...session,
    forensicOnly: false,
  });
}

/**
 * Return the reusable warm session for this exact scope, or null. Null on ANY
 * scope mismatch — reuse across runs, task dirs, artifact scopes, runners, or
 * review subjects is forbidden by design, not just unsupported.
 */
export function claimWarmReviewerSession(
  scope: WarmReviewerScope,
  options: { allowArtifactScopeChange?: boolean; consume?: boolean } = {},
): WarmReviewerSession | null {
  const key = sessionKey(scope.runId, scope.runner);
  const session = warmSessions.get(key);
  if (!session || session.forensicOnly) return null;
  if (
    session.runId !== scope.runId ||
    session.taskDir !== scope.taskDir ||
    (!options.allowArtifactScopeChange && session.artifactScope !== scope.artifactScope) ||
    session.runner !== scope.runner ||
    session.subjectRef !== scope.subjectRef
  ) {
    return null;
  }
  if (options.consume) warmSessions.set(key, { ...session, forensicOnly: true });
  return session;
}

/**
 * Invalidate a run's warm reviewer sessions (review-gate exit, run completion,
 * cancel). Records stay as forensic-only so operators can inspect what session
 * a reviewer used, but they can never be claimed again. Pass `runner` to scope
 * the invalidation to one reviewer's loop exit (a run can host reviews by
 * different runners; one loop finishing must not tear down another's session).
 */
export function invalidateWarmReviewerSessions(runId: string, runner?: string): number {
  let count = 0;
  for (const [key, session] of warmSessions) {
    if (session.runId !== runId || session.forensicOnly) continue;
    if (runner !== undefined && session.runner !== runner) continue;
    warmSessions.set(key, { ...session, forensicOnly: true });
    count += 1;
  }
  return count;
}

/** Slot release tears down every warm session that lived on the slot. */
export function invalidateWarmReviewerSessionsForSlot(slotId: string): number {
  let count = 0;
  for (const [key, session] of warmSessions) {
    if (session.slotId !== slotId || session.forensicOnly) continue;
    warmSessions.set(key, { ...session, forensicOnly: true });
    count += 1;
  }
  return count;
}

export function resetWarmReviewerSessionsForTest(): void {
  warmSessions.clear();
}

/** Recover only an explicitly continued, completed same-run reviewer after restart. */
export function persistedWarmReviewerSession(
  scope: WarmReviewerScope,
  run: Pick<
    Run,
    | 'id'
    | 'status'
    | 'slotId'
    | 'branch'
    | 'agentContexts'
    | 'engineState'
    | 'park'
    | 'resourcePosture'
  >,
): WarmReviewerSession | null {
  // A consumed or invalidated in-process claim must never be revived from disk.
  if (warmSessions.has(sessionKey(scope.runId, scope.runner))) return null;
  if (
    run.id !== scope.runId ||
    !run.slotId ||
    !scope.subjectRef ||
    run.branch !== scope.subjectRef ||
    isGateParkInFlightOrFreed(run) ||
    run.resourcePosture?.posture === 'terminal' ||
    ['done', 'failed', 'cancelled'].includes(run.status)
  )
    return null;
  const reviews = run.engineState?.publishGate?.independentReviews ?? [];
  const review = [...reviews]
    .reverse()
    .find((candidate) => candidate.runner === scope.runner && candidate.id !== scope.artifactScope);
  if (
    !review ||
    !['pass', 'issues'].includes(review.verdict) ||
    review.reviewSnapshot?.headRef !== scope.subjectRef
  )
    return null;
  const artifactScope = review.source === 'self-review' ? null : review.id;
  const context = [...(run.agentContexts ?? [])]
    .reverse()
    .find(
      (candidate) =>
        candidate.runId === run.id &&
        candidate.slotId === run.slotId &&
        candidate.role === 'self-review' &&
        candidate.runner === scope.runner &&
        candidate.status === 'complete' &&
        (candidate.artifactScope ?? null) === artifactScope &&
        candidate.taskFile?.startsWith(`${scope.taskDir}/`) &&
        candidate.runnerSessionId &&
        candidate.runnerSessionPath &&
        candidate.runnerSessionCapturedAt &&
        candidate.target?.window &&
        (!review.reviewerSessionId || candidate.runnerSessionId === review.reviewerSessionId),
    );
  if (!context) return null;
  return {
    ...scope,
    artifactScope,
    contextId: context.id,
    windowName: context.target!.window!,
    slotId: run.slotId,
    runnerSessionId: context.runnerSessionId!,
    runnerSessionPath: context.runnerSessionPath!,
    lastLoopNumber:
      context.reviewLoopNumber ?? review.attempts?.at(-1)?.loopNumber ?? review.loopNumber,
    lastReviewedHeadSha: review.reviewSnapshot?.headSha ?? null,
    forensicOnly: false,
  };
}

/** A requested continuation without prior review context must run a full first-look review. */
export function effectiveReviewSessionIntent(
  intent: ReviewSessionIntent,
  loopNumber: number,
  hasPriorReview: boolean,
): ReviewSessionIntent {
  return intent === 'resume' && loopNumber === 1 && !hasPriorReview ? 'reset' : intent;
}

export function shouldRetainCompletedReviewer(
  policy: ReviewSessionPolicy,
  intent: ReviewSessionIntent | undefined,
  hasReusableResult: boolean,
): boolean {
  return hasReusableResult && (policy === 'warm-per-reviewer' || intent === 'resume');
}
