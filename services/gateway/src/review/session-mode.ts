import {
  adoptedPublicationTarget,
  type AgentContext,
  parseGitHubPullUrl,
  parseGitHubRef,
  prNumberFromRunInput,
  type ReviewAttempt,
  type ReviewContinuationContext,
  type ReviewGatePayload,
  type ReviewIssue,
  type ReviewMode,
  type ReviewSessionRefusalReason,
  type ReviewSessionTrace,
  type ReviewStatus,
  type Run,
} from '@farmslot/protocol';

import type { ReReviewContinuation } from './review-agent.js';
import { reviewContextRoundId } from './review-round-budget.js';

export class WarmReviewRefusal extends Error {
  override name = 'WarmReviewRefusal';
  constructor(
    readonly reason: ReviewSessionRefusalReason,
    readonly detail: string,
  ) {
    super(`WARM review refused (${reason}): ${detail}. Wait or choose COLD.`);
  }
}

export interface WarmReviewerScope {
  runId: string;
  reviewId: string;
  /** The lineage's binding scope, from {@link warmLineageScope}. */
  familyId: string;
  project: string;
  ownerPrincipalId: string | null;
  /** Creator generation for tmux continuity; omission means zero. Native sessions are id-only. */
  ownerPrincipalGeneration?: number;
  transport: 'tmux' | 'native';
  taskDir: string;
  artifactScope: string | null;
  runner: string;
  model: string;
  effort: string | null;
  /** Present once the run has a PR; checked only when both sides have one. */
  repository?: string;
  prNumber?: number;
}

export interface WarmReviewerSession extends WarmReviewerScope {
  contextId: string;
  windowName: string;
  slotId: string;
  runnerSessionId: string;
  runnerSessionPath: string | null;
  lastLoopNumber: number;
  lastReviewedHeadSha: string;
  forensicOnly: boolean;
  busy: boolean;
}

const warmSessions = new Map<string, WarmReviewerSession>();
const sessionKey = (scope: Pick<WarmReviewerScope, 'familyId' | 'reviewId'>) =>
  `${scope.familyId}::${scope.reviewId}`;

/** A different PR refuses only when both the lineage and the run have one. */
function prDiffers(
  left: Pick<WarmReviewerScope, 'repository' | 'prNumber'>,
  right: Pick<WarmReviewerScope, 'repository' | 'prNumber'>,
): boolean {
  return (
    !!left.repository &&
    !!right.repository &&
    (left.repository.toLowerCase() !== right.repository.toLowerCase() ||
      left.prNumber !== right.prNumber)
  );
}

export function reviewPRIdentity(
  run:
    | (Pick<Run, 'ticketOrPr' | 'links' | 'prWork'> &
        Partial<Pick<Run, 'flowType' | 'prNumber' | 'engineState'>>)
    | null
    | undefined,
  options: { requirePRContext?: boolean } = {},
): { repository: string; prNumber: number } | null {
  if (!run) return null;
  const adopted = adoptedPublicationTarget(run);
  if (adopted) return { repository: adopted.repository, prNumber: adopted.prNumber };
  const pr = run.prWork?.pr;
  if (pr) return { repository: pr.repo, prNumber: pr.number };
  const prLink = run.links?.find((link) => link.label.toLowerCase() === 'pr');
  const source = prLink?.url ?? run.ticketOrPr;
  const pull = parseGitHubPullUrl(source);
  if (
    options.requirePRContext &&
    !prLink &&
    !pull &&
    (!run.flowType || prNumberFromRunInput({ ...run, flowType: run.flowType }) === null)
  )
    return null;
  const ref = parseGitHubRef(source) ?? pull;
  return ref ? { repository: ref.repo, prNumber: ref.number } : null;
}

/**
 * A lineage binds to its run family, so it works before a PR exists, and never continues in
 * another family (ADR-063 Amendment 5). `run rereview` and PR-rule review-pr chains keep their
 * own continuation rule: they bind to their PR.
 */
export function warmLineageScope(run: LineageRun): string {
  const pr = run.flowType === 'review-pr' ? reviewPRIdentity(run) : null;
  return pr ? `${pr.repository.toLowerCase()}#${pr.prNumber}` : run.familyId;
}

type LineageRun = Pick<Run, 'familyId' | 'ticketOrPr' | 'links' | 'prWork'> &
  Partial<Pick<Run, 'flowType' | 'prNumber' | 'engineState'>>;

/** The context naming a lineage of this run: its PR once there is one, else its run family. */
export function lineageContextForRun(run: LineageRun, reviewId: string): ReviewContinuationContext {
  return { ...(reviewPRIdentity(run) ?? { familyId: run.familyId }), reviewId };
}

/**
 * A review status's lineage, which names its reviewer session. A gate row's id names the row and
 * its artifacts; a pipeline row wraps the lineage in its own id.
 */
export function reviewLineageId(review: Pick<ReviewStatus, 'id' | 'session'>): string {
  return review.session?.reviewId ?? review.id;
}

/** Older runtime review IDs were aliases; their gateway artifact scope names the row. */
export function reviewerContextMatchesLineage(
  context: Pick<AgentContext, 'reviewId' | 'artifactScope'>,
  reviewId: string,
  artifactScope = reviewId,
): boolean {
  return context.reviewId === reviewId || context.artifactScope === artifactScope;
}

/** A lineage's latest gate row. */
export function latestReviewOfLineage<T extends Pick<ReviewStatus, 'id' | 'session'>>(
  reviews: readonly T[],
  lineageId: string,
): T | undefined {
  return [...reviews].reverse().find((review) => reviewLineageId(review) === lineageId);
}

/**
 * A lineage's last validated result: its row's, or its latest validated attempt's when the row's
 * request failed or was refused. Such a request ran no session, so its row records none.
 */
export function lastValidatedReview(review: ReviewStatus | undefined):
  | {
      headSha: string;
      issues: ReviewIssue[];
      loopNumber: number;
      session?: ReviewSessionTrace;
      sessionId?: string | null;
    }
  | undefined {
  const results: Array<
    ReviewAttempt & Pick<ReviewStatus, 'reviewedHeadSha' | 'reviewerSessionId'>
  > = review ? [review, ...[...(review.attempts ?? [])].reverse()] : [];
  const result = results.find(
    (candidate) => candidate.verdict === 'pass' || candidate.verdict === 'issues',
  );
  const headSha =
    result?.reviewSnapshot?.source === 'unavailable'
      ? undefined
      : (result?.reviewSnapshot?.headSha ?? result?.reviewedHeadSha);
  return result && headSha
    ? {
        headSha,
        issues: result.issues ?? [],
        loopNumber:
          [...(review?.attempts ?? [])]
            .reverse()
            .find((attempt) => attempt.completedAt && attempt.completedAt === result.completedAt)
            ?.loopNumber ?? result.loopNumber,
        session: result.session,
        sessionId:
          result.reviewerSessionId ?? result.usage?.runnerSessionId ?? result.session?.sessionId,
      }
    : undefined;
}

/**
 * A review's lineage qualifies for a re-review with a validated verdict and a recorded reviewed
 * head (ADR-063 Amendment 5); its findings go to a fallback's fresh session.
 */
export function reReviewOfStatus(
  review: ReviewStatus | undefined,
): ReReviewContinuation | undefined {
  const validated = lastValidatedReview(review);
  return validated
    ? { lastReviewedHeadSha: validated.headSha, priorIssues: validated.issues }
    : undefined;
}

/** A lineage continues only in its run family, and in its own PR once both sides have one. */
export function assertLineageBelongsToRun(
  lineage: ReviewContinuationContext,
  run: LineageRun,
): void {
  if (lineage.familyId && lineage.familyId !== run.familyId)
    throw new WarmReviewRefusal('session-unavailable', 'the lineage belongs to another run family');
  const identity = reviewPRIdentity(run);
  if (identity && prDiffers(identity, lineage))
    throw new WarmReviewRefusal('pr-mismatch', 'the lineage belongs to a different repository/PR');
}

export function registerWarmReviewerSession(
  session: Omit<WarmReviewerSession, 'forensicOnly' | 'busy'>,
): void {
  if (
    !session.reviewId.trim() ||
    !session.familyId.trim() ||
    !session.runnerSessionId.trim() ||
    !session.lastReviewedHeadSha.trim() ||
    (session.repository !== undefined &&
      (!session.repository.trim() ||
        !Number.isSafeInteger(session.prNumber) ||
        (session.prNumber ?? 0) < 1))
  )
    throw new Error(
      'Retained review requires its run family, session identity and last reviewed head',
    );
  warmSessions.set(sessionKey(session), { ...session, forensicOnly: false, busy: false });
}

export function claimWarmReviewerSession(
  scope: WarmReviewerScope,
  options: { consume?: boolean; allowBusy?: boolean } = {},
): WarmReviewerSession | null {
  const session = warmSessions.get(sessionKey(scope));
  if (!session || session.forensicOnly) return null;
  if (
    session.project !== scope.project ||
    session.ownerPrincipalId !== scope.ownerPrincipalId ||
    (session.ownerPrincipalGeneration ?? 0) !== (scope.ownerPrincipalGeneration ?? 0) ||
    session.transport !== scope.transport
  )
    throw new WarmReviewRefusal(
      'session-unavailable',
      'the retained reviewer has incompatible project, owner or transport',
    );
  if (prDiffers(session, scope))
    throw new WarmReviewRefusal('pr-mismatch', 'the retained reviewer belongs to another PR');
  if (session.runner !== scope.runner)
    throw new WarmReviewRefusal(
      'runner-mismatch',
      'the selected runner cannot continue this review lineage',
    );
  if (session.busy && !options.allowBusy)
    throw new WarmReviewRefusal('session-busy', 'the retained reviewer is running');
  if (session.model !== scope.model)
    throw new WarmReviewRefusal('model-mismatch', 'the retained reviewer cannot change model');
  if (session.effort !== scope.effort)
    throw new WarmReviewRefusal('effort-mismatch', 'the retained reviewer cannot change effort');
  if (options.consume)
    warmSessions.set(sessionKey(scope), { ...session, runId: scope.runId, busy: true });
  return session;
}

/**
 * Invalid execution retires this binding; successful completion remains reusable across run IDs.
 * A failed review retires only its own lineage's session.
 */
export function invalidateWarmReviewerSessions(
  runId: string,
  runner?: string,
  reviewId?: string,
): number {
  let count = 0;
  for (const [key, session] of warmSessions) {
    if (
      session.runId !== runId ||
      session.forensicOnly ||
      (runner && runner !== session.runner) ||
      (reviewId && reviewId !== session.reviewId)
    )
      continue;
    warmSessions.set(key, { ...session, forensicOnly: true, busy: false });
    count++;
  }
  return count;
}

/** Slot recycling cancels active claims; completed transcripts remain reusable across runs. */
export function invalidateWarmReviewerSessionsForSlot(slotId: string): number {
  let count = 0;
  for (const [key, session] of warmSessions) {
    if (session.slotId !== slotId || session.forensicOnly || !session.busy) continue;
    warmSessions.set(key, { ...session, forensicOnly: true, busy: false });
    count++;
  }
  return count;
}

export function resetWarmReviewerSessionsForTest(): void {
  warmSessions.clear();
}

type PrimaryReviewEvidence = Pick<ReviewGatePayload, 'session' | 'reviewSnapshot'> &
  Partial<Pick<ReviewGatePayload, 'repo' | 'prNumber'>>;
type PrimaryReviewEvidenceScope = Pick<WarmReviewerScope, 'reviewId'> & {
  repository: string;
  prNumber: number;
  runnerSessionId: string;
};

/** Standalone reviews retain their immutable result separately from publication reviews. */
export function primaryReviewedHeadForSession(
  run: Run,
  scope: PrimaryReviewEvidenceScope,
): string | null {
  if (run.flowType !== 'review-pr') return null;
  const evidence: PrimaryReviewEvidence[] = [
    ...(run.reviewResult ? [run.reviewResult] : []),
    ...[...(run.decisions ?? [])]
      .reverse()
      .flatMap((decision) => (decision.payload?.kind === 'review' ? [decision.payload] : [])),
  ];
  const matching = evidence.find((result) => {
    const trace = result.session;
    const snapshot = result.reviewSnapshot;
    const repository = result.repo ?? trace?.repository;
    const prNumber = result.prNumber ?? trace?.prNumber;
    return (
      trace?.reviewId === scope.reviewId &&
      trace.sessionId === scope.runnerSessionId &&
      ['fresh', 'resumed'].includes(trace.continuity) &&
      repository?.toLowerCase() === scope.repository.toLowerCase() &&
      prNumber === scope.prNumber &&
      (!trace.repository || trace.repository.toLowerCase() === scope.repository.toLowerCase()) &&
      (!trace.prNumber || trace.prNumber === scope.prNumber) &&
      snapshot?.source !== 'unavailable' &&
      !!snapshot?.headSha
    );
  });
  return matching?.reviewSnapshot?.headSha ?? null;
}

/** Recover a validated baseline, including its binding after a refunded resume failed. */
export function persistedWarmReviewerSession(
  scope: WarmReviewerScope,
  run: Run,
): WarmReviewerSession | null {
  const identity = reviewPRIdentity(run);
  if (run.project !== scope.project || warmLineageScope(run) !== scope.familyId) return null;
  if (identity && prDiffers(identity, scope)) return null;
  const known = warmSessions.get(sessionKey(scope));
  if (known?.forensicOnly) return null;
  const reviews = run.engineState?.publishGate?.reviews ?? [];
  const review = [...reviews]
    .reverse()
    .find(
      (candidate) =>
        reviewLineageId(candidate) === scope.reviewId &&
        candidate.runner === scope.runner &&
        lastValidatedReview(candidate)?.sessionId,
    );
  const validated = lastValidatedReview(review);
  if (!run.slotId) return null;
  // Native pipelines validate and persist each attempt before their final review row exists.
  const pipelineHead = (context: AgentContext): string | null => {
    const head = context.deliveryBaselineRef?.trim();
    return scope.transport === 'native' &&
      run.flowType !== 'review-pr' &&
      context.slotId === run.slotId &&
      context.reviewResultValidatedAt &&
      head &&
      /^[0-9a-f]{7,40}$/i.test(head)
      ? head
      : null;
  };
  let contexts = [...(run.agentContexts ?? [])].reverse().filter((candidate) => {
    // The accepted result binds legacy contexts even before validation timestamps existed.
    const legacyResult =
      validated?.sessionId &&
      candidate.runnerSessionId === validated.sessionId &&
      candidate.artifactScope === review?.id;
    const roundId = reviewContextRoundId(candidate);
    const refunded =
      candidate.status === 'failed' &&
      !!roundId &&
      !!run.reviewRoundSettlements?.[roundId] &&
      !candidate.reviewResultValidatedAt &&
      legacyResult;
    return (
      candidate.role === 'review' &&
      (scope.transport === 'native'
        ? candidate.nativeSession?.ownerPrincipalId === scope.ownerPrincipalId
        : !candidate.nativeSession &&
          (run.transport ?? 'tmux') === 'tmux' &&
          (run.createdByPrincipalId ?? null) === scope.ownerPrincipalId &&
          (run.createdByPrincipalGeneration ?? 0) === (scope.ownerPrincipalGeneration ?? 0)) &&
      reviewerContextMatchesLineage(candidate, scope.reviewId, review?.id) &&
      candidate.runner === scope.runner &&
      (candidate.status === 'complete' || refunded) &&
      (candidate.reviewResultValidatedAt || legacyResult) &&
      (candidate.runnerSessionCapturedAt || candidate.nativeSession?.acceptedAt) &&
      candidate.runnerSessionId &&
      (validated
        ? candidate.runnerSessionId === validated.sessionId
        : pipelineHead(candidate) ||
          (scope.repository &&
            scope.prNumber &&
            primaryReviewedHeadForSession(run, {
              reviewId: scope.reviewId,
              repository: scope.repository,
              prNumber: scope.prNumber,
              runnerSessionId: candidate.runnerSessionId,
            }))) &&
      ((candidate.runnerSessionPath && candidate.target?.window) ||
        (candidate.nativeSession &&
          !candidate.nativeSession.releasedAt &&
          !candidate.nativeSession.recovery))
    );
  });
  if (!validated && contexts.some(pipelineHead)) {
    const latest = contexts
      .map((context) => context.reviewResultValidatedAt ?? '')
      .sort()
      .at(-1);
    contexts = contexts.filter((context) => context.reviewResultValidatedAt === latest);
  }
  if (new Set(contexts.map((candidate) => candidate.runnerSessionId)).size > 1)
    throw new WarmReviewRefusal('missing-session', 'the reviewId has ambiguous session provenance');
  const context = contexts[0];
  if (!context) return null;
  const reviewedHeadSha =
    validated?.headSha ??
    pipelineHead(context) ??
    (scope.repository && scope.prNumber
      ? primaryReviewedHeadForSession(run, {
          reviewId: scope.reviewId,
          repository: scope.repository,
          prNumber: scope.prNumber,
          runnerSessionId: context.runnerSessionId!,
        })
      : null);
  if (!reviewedHeadSha) return null;
  return {
    ...scope,
    runId: run.id,
    taskDir: context.taskFile?.split('/').slice(0, -1).join('/') ?? scope.taskDir,
    artifactScope: context.artifactScope ?? null,
    model: context.model ?? '',
    effort: context.effort ?? null,
    contextId: context.id,
    windowName: context.target?.window ?? context.id,
    slotId: run.slotId,
    runnerSessionId: context.runnerSessionId!,
    runnerSessionPath: context.runnerSessionPath ?? null,
    lastLoopNumber: validated?.loopNumber ?? context.reviewLoopNumber ?? review?.loopNumber ?? 1,
    lastReviewedHeadSha: reviewedHeadSha,
    forensicOnly: false,
    busy: false,
  };
}

/**
 * Resolve one explicit lineage through retained facts; workflow callers never select a session by
 * runner. Callers check it with {@link usableRetainedReviewer}.
 */
export function resolveWarmReviewerSession(
  scope: WarmReviewerScope,
  runs: readonly Run[],
  options: { allowBusy?: boolean } = {},
): WarmReviewerSession | null {
  let session = claimWarmReviewerSession(scope, options);
  if (!session) {
    const matches = runs
      .map((run) => persistedWarmReviewerSession(scope, run))
      .filter((candidate): candidate is WarmReviewerSession => !!candidate);
    if (new Set(matches.map((candidate) => candidate.runnerSessionId)).size > 1)
      throw new WarmReviewRefusal(
        'missing-session',
        'the reviewId has ambiguous session provenance',
      );
    matches.sort((a, b) => {
      const left = runs.find((run) => run.id === a.runId);
      const right = runs.find((run) => run.id === b.runId);
      return (right?.completedAt ?? right?.updatedAt ?? '').localeCompare(
        left?.completedAt ?? left?.updatedAt ?? '',
      );
    });
    if (matches[0]) registerWarmReviewerSession(matches[0]);
    session = claimWarmReviewerSession(scope, options);
  }
  return session;
}

/**
 * The checks launch and the gate share before a retained reviewer continues its lineage
 * (ADR-063 Amendment 5): an owned, reusable native session on this slot that no other lineage
 * holds. A turn of the same lineage is busy, not unavailable. Returns the native context.
 */
export function usableRetainedReviewer(
  session: WarmReviewerSession,
  expected: {
    ownerPrincipalId: string | null;
    slotId: string | null | undefined;
    allowBusy?: boolean;
  },
  runs: readonly Run[],
): AgentContext | undefined {
  const context = runs
    .find((run) => run.id === session.runId)
    ?.agentContexts?.find((candidate) => candidate.id === session.contextId);
  if (
    session.transport === 'native' &&
    (!context?.nativeSession ||
      context.role !== 'review' ||
      context.nativeSession.ownerPrincipalId !== expected.ownerPrincipalId ||
      context.nativeSession.releasedAt ||
      context.nativeSession.recovery)
  )
    throw new WarmReviewRefusal(
      'session-unavailable',
      'the retained native reviewer has no owned reusable session',
    );
  if (session.slotId !== expected.slotId)
    throw new WarmReviewRefusal(
      'slot-mismatch',
      'the retained reviewer belongs to a different slot',
    );
  const holder = activeReviewerHolding(session.runnerSessionId, runs);
  if (holder && holder.reviewId !== session.reviewId)
    throw new WarmReviewRefusal('session-unavailable', 'another review lineage holds the session');
  if (holder && !expected.allowBusy)
    throw new WarmReviewRefusal('session-busy', 'the retained reviewer is active');
  return context;
}

/** The active review context running on a reviewer session, if any. */
export function activeReviewerHolding(
  runnerSessionId: string,
  runs: readonly Run[],
): NonNullable<Run['agentContexts']>[number] | undefined {
  for (const run of runs)
    for (const context of run.agentContexts ?? [])
      if (
        context.role === 'review' &&
        context.runnerSessionId === runnerSessionId &&
        ['launching', 'working', 'waiting'].includes(context.status)
      )
        return context;
  return undefined;
}

export function shouldRetainCompletedReviewer(hasReusableResult: boolean): boolean {
  return hasReusableResult;
}
export function parseReviewMode(raw: unknown): ReviewMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'warm' || raw === 'cold') return raw;
  throw new Error('Review mode must be warm or cold');
}
