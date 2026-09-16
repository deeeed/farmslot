import { isTerminalRunStatus, type RepeatReviewContext, type Run } from '@farmslot/protocol';

import { getRunnerDefinition } from '../runners/registry.js';

type WorkspaceReviewerRun = Pick<
  Run,
  | 'reviewScope'
  | 'prWork'
  | 'transport'
  | 'nativeOwnerPrincipalId'
  | 'createdByPrincipalId'
  | 'reviewWorkspaceTarget'
> & { metrics: Pick<Run['metrics'], 'runner' | 'model'> };

/** Shared ownership and runner predicate for both legacy recovery and new-round reuse. */
export function compatibleWorkspaceReviewer(run: WorkspaceReviewerRun, prior: Run) {
  const reviewer = prior.agentContexts?.find((candidate) => candidate.id === 'review');
  const sameOwner =
    Boolean(run.nativeOwnerPrincipalId) &&
    run.nativeOwnerPrincipalId === prior.nativeOwnerPrincipalId &&
    run.createdByPrincipalId === prior.createdByPrincipalId;
  const compatible =
    run.transport === 'tmux' &&
    prior.transport === 'tmux' &&
    Boolean(getRunnerDefinition(run.metrics.runner).workspaceTerminalSession) &&
    isTerminalRunStatus(prior.status) &&
    sameOwner &&
    prior.reviewWorkspace?.machine === run.reviewWorkspaceTarget?.machine &&
    reviewer?.runner === run.metrics.runner &&
    reviewer.model === run.metrics.model;
  return compatible ? reviewer : undefined;
}

/** Reuse a compatible chat, or preserve findings with an explicit fresh-session fallback. */
export function configureWorkspaceContinuity(
  run: WorkspaceReviewerRun,
  prior: Run,
  context: RepeatReviewContext,
): void {
  const incremental = run.reviewScope === 'incremental' && Boolean(context.priorReviewedHeadSha);
  context.reviewScope = incremental ? 'incremental' : 'full';
  context.sessionIntent =
    run.prWork?.review?.options.sessionIntent ?? (incremental ? 'resume' : 'reset');
  if (context.sessionIntent !== 'resume') {
    context.session = { intent: 'reset', continuity: 'fresh', priorRunId: prior.id };
    return;
  }
  const reviewer = compatibleWorkspaceReviewer(run, prior);
  context.session = reviewer?.runnerSessionId
    ? {
        intent: 'resume',
        continuity: 'resumed',
        priorRunId: prior.id,
        priorSessionId: reviewer.runnerSessionId,
        sessionId: reviewer.runnerSessionId,
      }
    : {
        intent: 'resume',
        continuity: 'fallback-fresh',
        priorRunId: prior.id,
        fallbackReason: 'session-unavailable',
      };
}
