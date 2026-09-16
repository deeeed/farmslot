import { isTerminalRunStatus, type RepeatReviewContext, type Run } from '@farmslot/protocol';

import { getRunnerDefinition } from '../runners/registry.js';

/** Session reuse is restricted to the recorded owner, machine, runner and model. */
export function configureWorkspaceContinuity(
  run: Run,
  prior: Run,
  context: RepeatReviewContext,
): void {
  const incremental = run.reviewScope === 'incremental' && Boolean(context.priorReviewedHeadSha);
  context.reviewScope = incremental ? 'incremental' : 'full';
  context.sessionIntent = incremental ? 'resume' : 'reset';
  if (!incremental) {
    context.session = { intent: 'reset', continuity: 'fresh', priorRunId: prior.id };
    return;
  }
  const reviewer = prior.agentContexts?.find((candidate) => candidate.id === 'review');
  const sameOwner =
    Boolean(run.nativeOwnerPrincipalId) &&
    run.nativeOwnerPrincipalId === prior.nativeOwnerPrincipalId &&
    run.createdByPrincipalId === prior.createdByPrincipalId;
  const resumable =
    run.transport === 'tmux' &&
    prior.transport === 'tmux' &&
    Boolean(getRunnerDefinition(run.metrics.runner).workspaceTerminalSession) &&
    isTerminalRunStatus(prior.status) &&
    sameOwner &&
    prior.reviewWorkspace?.machine === run.reviewWorkspaceTarget?.machine &&
    reviewer?.runner === run.metrics.runner &&
    reviewer.model === run.metrics.model &&
    reviewer.runnerSessionId;
  context.session = resumable
    ? {
        intent: 'resume',
        continuity: 'resumed',
        priorRunId: prior.id,
        priorSessionId: reviewer!.runnerSessionId!,
        sessionId: reviewer!.runnerSessionId!,
      }
    : {
        intent: 'resume',
        continuity: 'fallback-fresh',
        priorRunId: prior.id,
        fallbackReason: 'session-unavailable',
      };
}
