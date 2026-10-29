import {
  isTerminalRunStatus,
  parseGitHubRef,
  type RepeatReviewContext,
  type ReviewRequestContext,
  reviewResultForRun,
  type Run,
  type RunCreateParams,
} from '@farmslot/protocol';
import { resolveReviewMode } from '@farmslot/review-dispatch';

import { activeReviewerHolding, lineageContextForRun } from '../review/session-mode.js';
import {
  findLatestPriorReviewRun,
  incrementalReviewAvailable,
} from '../run-engine/engine-decisions.js';
import { runnerSupportsSessionReload } from '../runners/launch-command.js';
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
    reviewer.status === 'complete' &&
    reviewer.runner === run.metrics.runner
    ? reviewer
    : undefined;
}

/** Session reuse has stricter placement and capability requirements than lineage discovery. */
export function compatibleWorkspaceReviewer(run: WorkspaceReviewerRun, prior: Run) {
  const reviewer = ownedWorkspaceReviewer(run, prior);
  const compatible =
    reviewer &&
    run.transport === 'tmux' &&
    prior.transport === 'tmux' &&
    (Boolean(getRunnerDefinition(run.metrics.runner).workspaceTerminalSession) ||
      runnerSupportsSessionReload(run.metrics.runner ?? '')) &&
    (reviewer.effort ?? prior.effort ?? null) === (run.effort ?? null) &&
    prior.reviewWorkspace?.machine === run.reviewWorkspaceTarget?.machine &&
    !prior.reviewWorkspace?.cleanedAt &&
    reviewer.model === run.metrics.model;
  return compatible ? reviewer : undefined;
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
  const reason = !compatibleWorkspaceReviewer(run, prior)
    ? 'session-unavailable'
    : !sessionId
      ? 'missing-session'
      : holder
        ? 'session-busy'
        : undefined;
  if (reason) {
    const detail =
      reason === 'missing-session'
        ? 'runnerSessionId is missing from the prior reviewer'
        : reason === 'session-busy'
          ? 'the retained reviewer is active in another run'
          : 'the retained reviewer cannot resume on the selected machine, transport, model or effort';
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
        reason,
        detail,
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
