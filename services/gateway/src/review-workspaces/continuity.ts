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
import { getRunnerDefinition } from '../runners/registry.js';
import { runPrincipalOwner, samePrincipalOwner } from '../security/work-originator.js';

import { reviewWorkspaceExpiry } from './retention-policy.js';

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
  subject?: import('@farmslot/protocol').ReviewWorkspaceSubject,
): void {
  const mode = resolveReviewMode({ run });
  context.mode = mode;
  const expiresAt = reviewWorkspaceExpiry(prior);
  const expired = expiresAt && Date.now() >= Date.parse(expiresAt);
  const requestedLineage = run.reviewContext?.reviewLineages[0]?.reviewId;
  const retainedLineage = context.session?.reviewId ?? requestedLineage;
  if (expired && retainedLineage && (mode === 'warm' || requestedLineage)) {
    const reviewer = compatibleWorkspaceReviewer(run, prior);
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
        reason: 'session-unavailable',
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
