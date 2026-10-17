import {
  isTerminalRunStatus,
  parseGitHubRef,
  type RepeatReviewContext,
  type Run,
} from '@farmslot/protocol';
import { resolveReviewMode } from '@farmslot/review-dispatch';

import { incrementalReviewAvailable } from '../run-engine/engine-decisions.js';
import { getRunnerDefinition } from '../runners/registry.js';
import { runPrincipalOwner, samePrincipalOwner } from '../security/work-originator.js';

type WorkspaceReviewerRun = Pick<
  Run,
  | 'project'
  | 'ticketOrPr'
  | 'effort'
  | 'reviewMode'
  | 'prWork'
  | 'transport'
  | 'nativeOwnerPrincipalId'
  | 'createdByPrincipalId'
  | 'createdByPrincipalGeneration'
  | 'reviewWorkspaceTarget'
> & { metrics: Pick<Run['metrics'], 'runner' | 'model'> };

/** Shared ownership and runner predicate for both legacy recovery and new-round reuse. */
export function compatibleWorkspaceReviewer(run: WorkspaceReviewerRun, prior: Run) {
  const reviewer = prior.agentContexts?.find((candidate) => candidate.id === 'review');
  const owner = runPrincipalOwner(run);
  const priorOwner = runPrincipalOwner(prior);
  // Native session ownership is id-only; the creator must be the same identity generation.
  const sameOwner =
    Boolean(run.nativeOwnerPrincipalId) &&
    run.nativeOwnerPrincipalId === prior.nativeOwnerPrincipalId &&
    Boolean(owner && priorOwner && samePrincipalOwner(owner, priorOwner));
  const compatible =
    run.transport === 'tmux' &&
    prior.transport === 'tmux' &&
    Boolean(getRunnerDefinition(run.metrics.runner).workspaceTerminalSession) &&
    isTerminalRunStatus(prior.status) &&
    sameOwner &&
    run.project === prior.project &&
    reviewer?.role === 'review' &&
    reviewer.status === 'complete' &&
    (reviewer.effort ?? null) === (run.effort ?? null) &&
    prior.reviewWorkspace?.machine === run.reviewWorkspaceTarget?.machine &&
    reviewer?.runner === run.metrics.runner &&
    reviewer.model === run.metrics.model;
  return compatible ? reviewer : undefined;
}

/** Retained identity is required before a WARM workspace review can launch. */
export function configureWorkspaceContinuity(
  run: WorkspaceReviewerRun,
  prior: Run,
  context: RepeatReviewContext,
): void {
  const mode = resolveReviewMode({ run });
  context.mode = mode;
  if (mode === 'cold') {
    context.session = { mode, continuity: 'fresh', priorRunId: prior.id };
    return;
  }
  if (!incrementalReviewAvailable(context))
    throw new Error(
      `WARM review unavailable: ${context.warmUnavailableReason ?? 'missing prior reviewed head'}`,
    );
  const priorPr = prior.prWork?.pr ?? parseGitHubRef(prior.ticketOrPr);
  const requestedPr = run.prWork?.pr ?? parseGitHubRef(run.ticketOrPr);
  if (
    !priorPr ||
    !requestedPr ||
    priorPr.repo.toLowerCase() !== context.repository.toLowerCase() ||
    requestedPr.repo.toLowerCase() !== context.repository.toLowerCase() ||
    priorPr.number !== context.prNumber ||
    requestedPr.number !== context.prNumber
  )
    throw new Error('WARM review unavailable: repository/PR mismatch');
  const reviewer = compatibleWorkspaceReviewer(run, prior);
  if (!context.session?.reviewId || reviewer?.reviewId !== context.session.reviewId)
    throw new Error('WARM review unavailable: missing or foreign reviewId lineage');
  if (!reviewer?.runnerSessionId)
    throw new Error(
      'WARM review unavailable: retained session is missing, foreign or incompatible',
    );
  context.session = {
    mode,
    continuity: 'resumed',
    reviewId: reviewer.reviewId,
    repository: context.repository,
    prNumber: context.prNumber,
    lastReviewedHeadSha: context.priorReviewedHeadSha,
    priorRunId: prior.id,
    priorSessionId: reviewer.runnerSessionId,
    sessionId: reviewer.runnerSessionId,
  };
}
