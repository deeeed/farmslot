import {
  parseGitHubRef,
  type ReviewMode,
  type ReviewSessionRefusalReason,
  type Run,
} from '@farmslot/protocol';

export class WarmReviewRefusal extends Error {
  override name = 'WarmReviewRefusal';
  constructor(
    readonly reason: ReviewSessionRefusalReason,
    detail: string,
  ) {
    super(`WARM review refused (${reason}): ${detail}. Wait or choose COLD.`);
  }
}

export interface WarmReviewerScope {
  runId: string;
  reviewId: string;
  project: string;
  ownerPrincipalId: string | null;
  transport: 'tmux' | 'native';
  taskDir: string;
  artifactScope: string | null;
  runner: string;
  model: string;
  effort: string | null;
  repository: string;
  prNumber: number;
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
const sessionKey = (scope: Pick<WarmReviewerScope, 'repository' | 'prNumber' | 'reviewId'>) =>
  `${scope.repository.toLowerCase()}#${scope.prNumber}::${scope.reviewId}`;

export function reviewPRIdentity(
  run: Pick<Run, 'ticketOrPr' | 'links' | 'prWork'> | null | undefined,
): { repository: string; prNumber: number } | null {
  if (!run) return null;
  const pr = run.prWork?.pr;
  if (pr) return { repository: pr.repo, prNumber: pr.number };
  const ref = parseGitHubRef(
    run.links?.find((link) => link.label.toLowerCase() === 'pr')?.url ?? run.ticketOrPr,
  );
  return ref ? { repository: ref.repo, prNumber: ref.number } : null;
}

export function registerWarmReviewerSession(
  session: Omit<WarmReviewerSession, 'forensicOnly' | 'busy'>,
): void {
  if (
    !session.reviewId.trim() ||
    !session.runnerSessionId.trim() ||
    !session.lastReviewedHeadSha.trim() ||
    !session.repository.trim() ||
    !Number.isSafeInteger(session.prNumber) ||
    session.prNumber < 1
  )
    throw new Error(
      'Retained review requires repository/PR, session identity and last reviewed head',
    );
  warmSessions.set(sessionKey(session), { ...session, forensicOnly: false, busy: false });
}

export function claimWarmReviewerSession(
  scope: WarmReviewerScope,
  options: { consume?: boolean } = {},
): WarmReviewerSession | null {
  const session = warmSessions.get(sessionKey(scope));
  if (!session || session.forensicOnly) return null;
  if (
    session.project !== scope.project ||
    session.ownerPrincipalId !== scope.ownerPrincipalId ||
    session.transport !== scope.transport
  )
    throw new WarmReviewRefusal(
      'session-unavailable',
      'the retained reviewer has incompatible project, owner or transport',
    );
  if (session.runner !== scope.runner)
    throw new WarmReviewRefusal(
      'runner-mismatch',
      'the selected runner cannot continue this review lineage',
    );
  if (session.busy) throw new WarmReviewRefusal('session-busy', 'the retained reviewer is running');
  if (session.model !== scope.model)
    throw new WarmReviewRefusal('model-mismatch', 'the retained reviewer cannot change model');
  if (session.effort !== scope.effort)
    throw new WarmReviewRefusal('effort-mismatch', 'the retained reviewer cannot change effort');
  if (options.consume)
    warmSessions.set(sessionKey(scope), { ...session, runId: scope.runId, busy: true });
  return session;
}

/** Invalid execution retires this binding; successful completion remains reusable across run IDs. */
export function invalidateWarmReviewerSessions(runId: string, runner?: string): number {
  let count = 0;
  for (const [key, session] of warmSessions) {
    if (session.runId !== runId || session.forensicOnly || (runner && runner !== session.runner))
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

/** Recover only completed reviewer contexts with matching PR/head verdict provenance. */
export function persistedWarmReviewerSession(
  scope: WarmReviewerScope,
  run: Run,
): WarmReviewerSession | null {
  const identity = reviewPRIdentity(run);
  if (
    run.project !== scope.project ||
    (run.nativeOwnerPrincipalId ?? run.createdByPrincipalId ?? null) !== scope.ownerPrincipalId ||
    (run.transport ?? 'tmux') !== scope.transport
  )
    return null;
  if (
    !identity ||
    identity.repository.toLowerCase() !== scope.repository.toLowerCase() ||
    identity.prNumber !== scope.prNumber
  )
    return null;
  const known = warmSessions.get(sessionKey(scope));
  if (known?.forensicOnly) return null;
  const reviews = run.engineState?.publishGate?.reviews ?? [];
  const review = [...reviews]
    .reverse()
    .find(
      (candidate) =>
        candidate.id === scope.reviewId &&
        candidate.runner === scope.runner &&
        ['pass', 'issues'].includes(candidate.verdict) &&
        candidate.reviewedHeadSha &&
        candidate.reviewerSessionId,
    );
  if (!review?.reviewedHeadSha || !review.reviewerSessionId || !run.slotId) return null;
  const context = [...(run.agentContexts ?? [])]
    .reverse()
    .find(
      (candidate) =>
        candidate.role === 'review' &&
        candidate.reviewId === scope.reviewId &&
        candidate.runner === scope.runner &&
        candidate.status === 'complete' &&
        candidate.reviewResultValidatedAt &&
        (candidate.runnerSessionCapturedAt || candidate.nativeSession?.acceptedAt) &&
        candidate.runnerSessionId === review.reviewerSessionId &&
        ((candidate.runnerSessionPath && candidate.target?.window) ||
          (candidate.nativeSession &&
            !candidate.nativeSession.releasedAt &&
            !candidate.nativeSession.recovery)),
    );
  if (!context) return null;
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
    lastLoopNumber: context.reviewLoopNumber ?? review.loopNumber,
    lastReviewedHeadSha: review.reviewedHeadSha,
    forensicOnly: false,
    busy: false,
  };
}

/** Resolve one explicit lineage through retained facts; workflow callers never select a session by runner. */
export function resolveWarmReviewerSession(
  scope: WarmReviewerScope,
  runs: readonly Run[],
): WarmReviewerSession | null {
  let session = claimWarmReviewerSession(scope);
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
    session = claimWarmReviewerSession(scope);
  }
  if (
    session &&
    runs.some((run) =>
      run.agentContexts?.some(
        (context) =>
          context.role === 'review' &&
          context.runnerSessionId === session!.runnerSessionId &&
          ['launching', 'working', 'waiting'].includes(context.status),
      ),
    )
  )
    throw new WarmReviewRefusal(
      'session-busy',
      'the retained reviewer is owned by an active review',
    );
  return session;
}

export function shouldRetainCompletedReviewer(hasReusableResult: boolean): boolean {
  return hasReusableResult;
}
export function parseReviewMode(raw: unknown): ReviewMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'warm' || raw === 'cold') return raw;
  throw new Error('Review mode must be warm or cold');
}
