import type { Run } from '../contracts/runs.js';
import { isRecord } from '../recipe/common.js';

type RetainedWorkerRun = Pick<Run, 'id' | 'agentContexts' | 'sessionUsage' | 'engineState'> &
  Partial<Pick<Run, 'steps' | 'decisions'>>;

/** Only a recorded cold attempt can prove a pipeline review is independent. */
export function coldPipelineReviewSessions(
  run: Pick<RetainedWorkerRun, 'id' | 'steps'>,
): Set<string> {
  const sessions = new Set<string>();
  for (const step of run.steps ?? []) {
    if (step.name !== 'review' || !step.outputs) continue;
    const { outputs } = step;
    const attempts = Array.isArray(outputs.attempts) ? outputs.attempts.filter(isRecord) : [];
    // A final receipt with attempt history is identified by that attempt's own mode.
    for (const attempt of attempts.length ? attempts : [outputs]) {
      const session = isRecord(attempt.session) ? attempt.session : undefined;
      const usage = isRecord(attempt.usage) ? attempt.usage : undefined;
      const sessionId =
        usage?.runnerSessionId ??
        session?.sessionId ??
        (attempt === outputs ? outputs.reviewerSessionId : undefined);
      if (
        (attempt.mode ?? session?.mode) === 'cold' &&
        typeof sessionId === 'string' &&
        !usage?.includesPriorRunLifetime &&
        (!session?.priorRunId || session.priorRunId === run.id)
      )
        sessions.add(sessionId);
    }
  }
  return sessions;
}

/** Identify lifetime receipts that a retained dispatch cannot allocate to this run. */
export function retainedWorkerLifetimeSessions(run: RetainedWorkerRun): ReadonlySet<string> {
  const ids = new Set<string>();
  const inheritedTarget = run.steps?.find(
    (step) =>
      step.name === 'dispatch' &&
      step.status === 'done' &&
      (step.outputs?.nudged === true || step.outputs?.warmHandoff === true),
  )?.outputs?.workerTarget;
  const retainedActors = (run.agentContexts ?? []).filter((actor) => {
    const source = actor.nativeSession?.handoffFrom;
    return (
      (source && source.runId !== run.id) ||
      (typeof inheritedTarget === 'string' && actor.target?.target === inheritedTarget)
    );
  });
  // A tmux target can be rebound to a fresh worker. Earlier receipts on the same
  // context still cover possible inherited spend until usage is scoped to this run.
  if (retainedActors.length) {
    const actorIds = new Set(retainedActors.map(({ id }) => id));
    const roles = new Set<string>(
      retainedActors.filter((actor) => !actor.nativeSession?.handoffFrom).map(({ role }) => role),
    );
    for (const { runnerSessionId } of retainedActors) if (runnerSessionId) ids.add(runnerSessionId);
    for (const row of run.sessionUsage ?? []) {
      if (
        row.runnerSessionId &&
        (row.contextIds?.some((id) => actorIds.has(id)) ||
          (!row.contextIds?.length && row.role && roles.has(row.role)))
      )
        ids.add(row.runnerSessionId);
    }
  } else if (
    typeof inheritedTarget === 'string' ||
    run.engineState?.flags?.warmHandoffSucceeded ||
    run.engineState?.flags?.nudgeReuse
  ) {
    // A dispatch replay can clear its receipt. The retained dispatch flag and
    // an agent lifetime total alone cannot attribute the cost to this run.
    const coldReviews = new Set<string>();
    let reviews = run.engineState?.publishGate?.reviews;
    if (!reviews?.length && run.decisions) {
      for (let index = run.decisions.length - 1; index >= 0; index--) {
        const payload = run.decisions[index]?.payload;
        if (payload?.kind === 'ready') {
          reviews = payload.reviews;
          break;
        }
      }
    }
    for (const review of reviews ?? []) {
      const sessionId = review.usage?.runnerSessionId ?? review.reviewerSessionId;
      if (review.mode === 'cold' && sessionId) coldReviews.add(sessionId);
      for (const attempt of review.attempts ?? []) {
        const sessionId = attempt.usage?.runnerSessionId ?? attempt.session?.sessionId;
        if (attempt.mode === 'cold' && sessionId) coldReviews.add(sessionId);
      }
    }
    for (const session of coldPipelineReviewSessions(run)) coldReviews.add(session);
    for (const row of run.sessionUsage ?? []) {
      if (!row.runnerSessionId || row.kind === 'helper' || row.identityKind === 'request') continue;
      const coldReview =
        row.role === 'review' &&
        !row.roles?.some((role) => role !== 'review') &&
        coldReviews.has(row.runnerSessionId);
      if (!coldReview) ids.add(row.runnerSessionId);
    }
  }
  return ids;
}
