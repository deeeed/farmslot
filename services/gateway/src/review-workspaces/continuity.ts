import {
  type AgentContext,
  isTerminalRunStatus,
  parseGitHubRef,
  type RepeatReviewContext,
  type ReviewRequestContext,
  reviewResultForRun,
  type ReviewSessionFallback,
  type Run,
  type RunCreateParams,
} from '@farmslot/protocol';
import { resolveReviewMode } from '@farmslot/review-dispatch';

import { activeReviewerHolding, lineageContextForRun } from '../review/session-mode.js';
import {
  findLatestPriorReviewRun,
  incrementalReviewAvailable,
} from '../run-engine/engine-decisions.js';
import { getRunnerDefinition } from '../runners/registry.js';
import {
  type PrincipalOwner,
  runPrincipalOwner,
  samePrincipalOwner,
} from '../security/work-originator.js';

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

/** A validated lineage may outlive its original machine or retained session. */
function ownedWorkspaceReviewer(run: WorkspaceReviewerRun, prior: Run) {
  const reviewer = prior.agentContexts?.find((candidate) => candidate.id === 'review');
  const owner = runPrincipalOwner(run);
  const priorOwner = runPrincipalOwner(prior);
  // Native session ownership is id-only; the creator must be the same identity generation.
  const sameOwner =
    Boolean(run.nativeOwnerPrincipalId) &&
    run.nativeOwnerPrincipalId === prior.nativeOwnerPrincipalId &&
    Boolean(owner && priorOwner && samePrincipalOwner(owner, priorOwner));
  return (isTerminalRunStatus(prior.status) || prior.status === 'blocked') &&
    sameOwner &&
    run.project === prior.project &&
    reviewer?.role === 'review' &&
    reviewer.runner === run.metrics.runner
    ? reviewer
    : undefined;
}

function workspaceSessionFailure(
  run: WorkspaceReviewerRun,
  prior: Run,
  reviewer: AgentContext,
): Pick<ReviewSessionFallback, 'reason' | 'detail'> | undefined {
  if (
    run.transport !== 'tmux' ||
    prior.transport !== 'tmux' ||
    !getRunnerDefinition(run.metrics.runner).workspaceTerminalSession
  )
    return {
      reason: 'unsupported-runner',
      detail: 'The selected runner/transport has no retained workspace-session launch',
    };
  if (reviewer.status !== 'complete')
    return {
      reason: 'session-unavailable',
      detail: `Prior reviewer status is ${reviewer.status}; its validated result remains available`,
    };
  if (prior.reviewWorkspace?.machine !== run.reviewWorkspaceTarget?.machine)
    return {
      reason: 'slot-mismatch',
      detail: `Prior review machine ${prior.reviewWorkspace?.machine ?? 'unknown'} differs from selected machine ${run.reviewWorkspaceTarget?.machine ?? 'unknown'}`,
    };
  if (reviewer.model !== run.metrics.model)
    return {
      reason: 'model-mismatch',
      detail: 'Selected model differs from the retained reviewer model',
    };
  if ((reviewer.effort ?? prior.effort ?? null) !== (run.effort ?? null))
    return {
      reason: 'effort-mismatch',
      detail: 'Selected effort differs from the retained reviewer effort',
    };
}

/** Cursor's chat identity survives cleanup of the old source checkout. */
export function compatibleWorkspaceReviewer(run: WorkspaceReviewerRun, prior: Run) {
  const reviewer = ownedWorkspaceReviewer(run, prior);
  return reviewer && !workspaceSessionFailure(run, prior, reviewer) ? reviewer : undefined;
}

/** Resolve an omitted or legacy family-only context from the same owner's completed review. */
export function resolveWorkspaceReviewContext(
  input: RunCreateParams,
  owner: PrincipalOwner,
  runs: readonly Run[],
): ReviewRequestContext | undefined {
  const requested = input.reviewContext;
  if (
    input.flowType !== 'review-pr' ||
    resolveReviewMode({ run: input }) !== 'warm' ||
    !input.reviewWorkspaceTarget ||
    (requested &&
      (requested.reviewLineages.length !== 1 ||
        requested.reviewLineages.some((binding) => binding?.repository)))
  )
    return requested;
  const current: WorkspaceReviewerRun = {
    project: input.project,
    ticketOrPr: input.ticketOrPr,
    effort: input.effort,
    reviewMode: input.reviewMode,
    transport: input.transport,
    nativeOwnerPrincipalId: owner.ownerId,
    createdByPrincipalId: owner.ownerId,
    createdByPrincipalGeneration: owner.ownerGeneration,
    reviewWorkspaceTarget: input.reviewWorkspaceTarget,
    metrics: { runner: input.runner ?? null, model: input.model ?? null },
  };
  const prior = findLatestPriorReviewRun(
    {
      id: '',
      flowType: 'review-pr',
      project: input.project,
      ticketOrPr: input.ticketOrPr,
      reviewContext: requested,
    },
    runs.filter((candidate) => {
      const reviewer = ownedWorkspaceReviewer(current, candidate);
      const family = requested?.reviewLineages[0]?.familyId;
      return (
        Boolean(reviewer?.reviewId && reviewResultForRun(candidate)?.reviewSnapshot?.headSha) &&
        (!family || candidate.familyId === family)
      );
    }),
  );
  const reviewer = prior && ownedWorkspaceReviewer(current, prior);
  return prior && reviewer?.reviewId
    ? { reviewLineages: [lineageContextForRun(prior, reviewer.reviewId)] }
    : requested;
}

/** Continue the owned lineage, using a fresh delta session when reuse is unavailable. */
export function configureWorkspaceContinuity(
  run: WorkspaceReviewerRun,
  prior: Run,
  context: RepeatReviewContext,
  runs: readonly Run[] = [],
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
  const reviewer = ownedWorkspaceReviewer(run, prior);
  if (!context.session?.reviewId || reviewer?.reviewId !== context.session.reviewId)
    throw new Error('WARM review unavailable: missing or foreign reviewId lineage');
  const sessionId = reviewer.runnerSessionId ?? undefined;
  const holder = sessionId && activeReviewerHolding(sessionId, runs);
  const unavailable: Pick<ReviewSessionFallback, 'reason' | 'detail'> | undefined = !sessionId
    ? { reason: 'missing-session', detail: 'runnerSessionId is missing from the prior reviewer' }
    : holder
      ? { reason: 'session-busy', detail: 'The retained reviewer is active in another run' }
      : workspaceSessionFailure(run, prior, reviewer);
  if (unavailable) {
    context.mode = 'cold';
    context.session = {
      mode: 'cold',
      continuity: 'fresh',
      reviewId: reviewer.reviewId,
      repository: context.repository,
      prNumber: context.prNumber,
      lastReviewedHeadSha: context.priorReviewedHeadSha,
      priorRunId: prior.id,
      priorSessionId: sessionId,
      fallback: {
        ...unavailable,
        comparedRanges: [`${context.priorReviewedHeadSha}..${context.currentHeadSha}`],
      },
    };
    return;
  }
  context.session = {
    mode,
    continuity: 'resumed',
    reviewId: reviewer.reviewId,
    repository: context.repository,
    prNumber: context.prNumber,
    lastReviewedHeadSha: context.priorReviewedHeadSha,
    priorRunId: prior.id,
    priorSessionId: sessionId,
    sessionId,
  };
}
