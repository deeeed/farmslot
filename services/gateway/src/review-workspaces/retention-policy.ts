import {
  DEFAULT_REVIEW_WORKSPACE_RETENTION_DAYS,
  isTerminalRunStatus,
  type MonitoredPRIdentity,
  parseGitHubPullUrl,
  parseGitHubRef,
  type Run,
} from '@farmslot/protocol';

export function reviewWorkspaceExpiry(
  run: Pick<Run, 'reviewWorkspace' | 'completedAt'>,
): string | null {
  const saved = run.reviewWorkspace?.retainedUntil;
  if (saved) return Number.isFinite(Date.parse(saved)) ? saved : null;
  const ended = run.reviewWorkspace?.retainedAt ?? run.completedAt;
  if (!ended || !Number.isFinite(Date.parse(ended))) return null;
  const days = run.reviewWorkspace?.retentionDays ?? DEFAULT_REVIEW_WORKSPACE_RETENTION_DAYS;
  return new Date(Date.parse(ended) + days * 86400000).toISOString();
}

export function reviewPR(run: Pick<Run, 'ticketOrPr' | 'prWork'>): MonitoredPRIdentity | null {
  if (run.prWork?.pr) return run.prWork.pr;
  const pr = parseGitHubRef(run.ticketOrPr) ?? parseGitHubPullUrl(run.ticketOrPr);
  return pr ? { host: 'github.com', repo: pr.repo, number: pr.number } : null;
}

export function sameReviewPR(
  a: Pick<Run, 'ticketOrPr' | 'prWork'>,
  b: Pick<Run, 'ticketOrPr' | 'prWork'>,
): boolean {
  const left = reviewPR(a),
    right = reviewPR(b);
  return (
    !!left &&
    !!right &&
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase() &&
    left.number === right.number
  );
}

/** Retention keeps files/conversation identity, not an active machine admission. */
export function retainedWorkspaceIsIdle(
  run: Pick<Run, 'status' | 'reviewWorkspace' | 'agentContexts'>,
): boolean {
  return (
    !!run.reviewWorkspace?.retainedAt &&
    !!run.reviewWorkspace.executionStoppedAt &&
    !(run.agentContexts ?? []).some(
      (context) =>
        context.nativeSession &&
        !context.nativeSession.closedAt &&
        !context.nativeSession.releasedAt,
    ) &&
    ['done', 'failed', 'cancelled', 'blocked'].includes(run.status) &&
    !(run.agentContexts ?? []).some(
      (context) => !['complete', 'failed', 'idle'].includes(context.status),
    )
  );
}

type RetentionPeer = Pick<Run, 'ticketOrPr' | 'prWork' | 'status' | 'decisions' | 'agentContexts'>;
export function workspaceRetentionProtected(
  run: Pick<Run, 'ticketOrPr' | 'prWork'>,
  all: readonly RetentionPeer[],
  pending: readonly Pick<Run, 'ticketOrPr' | 'prWork'>[],
): boolean {
  if (!reviewPR(run)) return true;
  return (
    all.some(
      (other) =>
        sameReviewPR(run, other) &&
        (!isTerminalRunStatus(other.status) ||
          other.decisions.some((decision) => !decision.resolvedAt) ||
          other.agentContexts?.some((context) =>
            ['working', 'launching', 'waiting'].includes(context.status),
          )),
    ) || pending.some((other) => sameReviewPR(run, other))
  );
}
