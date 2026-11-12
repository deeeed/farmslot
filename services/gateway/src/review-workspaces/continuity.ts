import {
  isTerminalRunStatus,
  parseGitHubPullUrl,
  parseGitHubRef,
  type RepeatReviewContext,
  type Run,
  type RunReviewResult,
} from '@farmslot/protocol';
import { resolveReviewMode } from '@farmslot/review-dispatch';

import { incrementalReviewAvailable } from '../run-engine/engine-decisions.js';
import { runnerSupportsSessionContinuation } from '../runners/registry.js';
import { runPrincipalOwner, samePrincipalOwner } from '../security/work-originator.js';

import { reviewWorkspaceExpiry, sameReviewPR } from './retention-policy.js';

type WorkspaceReviewerRun = Pick<
  Run,
  | 'id'
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
  | 'reviewContext'
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
    isTerminalRunStatus(prior.status) &&
    (!prior.reviewWorkspace?.retainedAt || !!prior.reviewWorkspace.executionStoppedAt) &&
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

/** Follow only stopped, no-verdict transfers; the validated baseline remains unchanged. */
export function resolveWorkspaceContinuationSource(
  run: WorkspaceReviewerRun,
  baseline: Run,
  read: (id: string) => Run | undefined,
  reviewId: string,
): Run {
  const reviewer = compatibleWorkspaceReviewer(run, baseline);
  if (!reviewer || reviewer.reviewId !== reviewId)
    throw new Error('WARM review unavailable: incompatible retained reviewer source');
  let source = baseline;
  while (
    source.reviewWorkspace?.transferredTo &&
    source.reviewWorkspace.transferredTo.runId !== run.id
  ) {
    const successorId = source.reviewWorkspace.transferredTo.runId;
    const successor = read(successorId);
    const successorOwner = successor && runPrincipalOwner(successor);
    const owner = runPrincipalOwner(run);
    if (
      !successor ||
      !isTerminalRunStatus(successor.status) ||
      successor.reviewResult ||
      successor.decisions?.some((decision) => !decision.resolvedAt) ||
      !successor.reviewWorkspace?.executionStoppedAt ||
      successor.reviewWorkspace.continuedFrom?.runId !== source.id ||
      successor.reviewWorkspace.workspaceId !== source.reviewWorkspace?.workspaceId ||
      successor.reviewWorkspace.checkoutPath !== source.reviewWorkspace?.checkoutPath ||
      successor.transport !== 'tmux' ||
      successor.nativeOwnerPrincipalId !== run.nativeOwnerPrincipalId ||
      successor.reviewWorkspace.machine !== run.reviewWorkspaceTarget?.machine ||
      !sameReviewPR(successor, run) ||
      successor.agentContexts?.some(
        (context) => !['complete', 'failed', 'idle'].includes(context.status),
      ) ||
      Object.values(successor.reviewRoundSettlements ?? {}).some(
        (settlement) => settlement.kind === 'pending' || settlement.kind === 'verdict',
      ) ||
      successor.project !== run.project ||
      !owner ||
      !successorOwner ||
      !samePrincipalOwner(owner, successorOwner) ||
      successor.metrics.runner !== run.metrics.runner ||
      successor.metrics.model !== run.metrics.model ||
      (successor.effort ?? null) !== (run.effort ?? null) ||
      successor.repeatReviewContext?.session?.reviewId !== reviewer.reviewId ||
      successor.repeatReviewContext.session.priorSessionId !== reviewer.runnerSessionId
    )
      throw new Error('WARM review unavailable: retained workspace is held by its successor');
    source = successor;
  }
  return source;
}

/** Retained identity is required before a WARM workspace review can launch. */
export function configureWorkspaceContinuity(
  run: WorkspaceReviewerRun,
  prior: Run,
  context: RepeatReviewContext,
  subject?: import('@farmslot/protocol').ReviewWorkspaceSubject,
  history: readonly Run[] = [],
): void {
  const mode = resolveReviewMode({ run });
  context.mode = mode;
  const expiresAt = reviewWorkspaceExpiry(prior);
  const expired = expiresAt && Date.now() >= Date.parse(expiresAt);
  const requestedLineage = run.reviewContext?.reviewLineages[0]?.reviewId;
  const retainedLineage = context.session?.reviewId ?? requestedLineage;
  if (expired && retainedLineage && (mode === 'warm' || requestedLineage)) {
    const reviewer =
      mode === 'cold'
        ? prior.agentContexts?.find((context) => context.id === 'review')
        : compatibleWorkspaceReviewer(run, prior);
    if (!reviewer || reviewer.reviewId !== retainedLineage)
      throw new Error('WARM review unavailable: foreign or incompatible retained reviewer');
    context.mode = 'cold';
    context.session = {
      mode: 'cold',
      continuity: 'fresh',
      reviewId: reviewer.reviewId,
      priorRunId: prior.id,
      priorSessionId: reviewer.runnerSessionId ?? undefined,
      repository: context.repository,
      prNumber: context.prNumber,
      lastReviewedHeadSha: context.priorReviewedHeadSha,
      fallback: {
        reason: 'retention-expired',
        detail: `Retained reviewer expired at ${expiresAt}; starting a cold review.`,
        comparedRanges: subject ? [`${subject.baseSha}...${subject.headSha}`] : [],
      },
    };
    return;
  }
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
  const source = resolveWorkspaceContinuationSource(
    run,
    prior,
    (id) => history.find((candidate) => candidate.id === id),
    context.session.reviewId,
  );
  let fallbackReason: 'session-resume-unsupported' | 'session-unavailable' | undefined = source
    .reviewWorkspace?.cleanedAt
    ? 'session-unavailable'
    : undefined;
  if (!runnerSupportsSessionContinuation(run.metrics.runner, 'tmux'))
    fallbackReason = 'session-resume-unsupported';
  if (fallbackReason) {
    const currentHead = context.currentHeadSha ?? subject?.headSha;
    if (!currentHead) throw new Error('WARM review unavailable: missing current reviewed head');
    context.mode = 'cold';
    context.session = {
      mode: 'cold',
      continuity: 'fresh',
      reviewId: reviewer.reviewId,
      priorRunId: source.id,
      priorSessionId: reviewer.runnerSessionId ?? undefined,
      repository: context.repository,
      prNumber: context.prNumber,
      lastReviewedHeadSha: context.priorReviewedHeadSha,
      fallback: {
        reason: fallbackReason,
        detail:
          fallbackReason === 'session-resume-unsupported'
            ? 'The runner cannot continue a saved terminal session; reviewing the retained delta in a fresh session.'
            : 'The retained source was reclaimed; reviewing the retained delta in a fresh session.',
        comparedRanges: [`${context.priorReviewedHeadSha}..${currentHead}`],
      },
    };
    return;
  }
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
    priorRunId: source.id,
    priorSessionId: reviewer.runnerSessionId,
    sessionId: reviewer.runnerSessionId,
  };
}

/** Bind only structured reviewer identity to the immutable subject that produced this result. */
export function bindWorkspaceReviewResult(run: Run, result: RunReviewResult): RunReviewResult {
  const reviewer = run.agentContexts?.find((context) => context.id === 'review');
  const subject = run.reviewWorkspaceSubject;
  const pr = run.prWork?.pr ?? parseGitHubRef(run.ticketOrPr) ?? parseGitHubPullUrl(run.ticketOrPr);
  if (!reviewer?.reviewId || !reviewer.runnerSessionId || !subject || !pr) return result;
  if (
    result.reviewSnapshot?.source === 'unavailable' ||
    pr.repo.toLowerCase() !== subject.repository.toLowerCase() ||
    (result.reviewSnapshot?.headSha && result.reviewSnapshot.headSha !== subject.headSha)
  )
    throw new Error('Reviewer result does not match its frozen repository/head');
  if (
    result.session &&
    (result.session.reviewId !== reviewer.reviewId ||
      result.session.sessionId !== reviewer.runnerSessionId)
  )
    throw new Error('Reviewer result has conflicting conversation or lineage identity');
  const prior = run.repeatReviewContext?.session;
  const mode = resolveReviewMode({ run });
  if (mode === 'warm' && prior?.priorSessionId !== reviewer.runnerSessionId)
    throw new Error('WARM reviewer did not preserve its retained conversation');
  return {
    ...result,
    reviewSnapshot: result.reviewSnapshot ?? {
      source: 'github-pr',
      capturedAt: subject.capturedAt,
      baseSha: subject.baseSha,
      headSha: subject.headSha,
    },
    session: {
      mode,
      continuity: mode === 'warm' ? 'resumed' : 'fresh',
      reviewId: reviewer.reviewId,
      sessionId: reviewer.runnerSessionId,
      repository: subject.repository,
      prNumber: pr.number,
      lastReviewedHeadSha: subject.headSha,
      runner: reviewer.runner ?? undefined,
      model: reviewer.model,
      effort: reviewer.effort ?? run.effort ?? null,
      ...(prior?.priorRunId ? { priorRunId: prior.priorRunId } : {}),
      ...(prior?.priorSessionId ? { priorSessionId: prior.priorSessionId } : {}),
      ...(prior?.fallback ? { fallback: prior.fallback } : {}),
    },
  };
}
