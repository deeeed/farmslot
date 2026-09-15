import type { PRStatus } from '@farmslot/protocol';

export type PRAttentionKind =
  | 'conflict'
  | 'ci-failed'
  | 'bot-comments'
  | 'changes-requested'
  | 'review-required'
  | 'ci-pending'
  | 'ready';

export interface PRAttentionReason {
  kind: PRAttentionKind;
  /** Short chip text, e.g. "CI failed: lint, typecheck". */
  label: string;
  /** Longer explanation for a tooltip or expanded view. */
  detail: string;
  tone: 'fail' | 'warn' | 'ok' | 'muted';
}

const MAX_NAMES = 2;
const MAX_NAME_CHARS = 32;

/** Chip-sized list: at most two names, each clipped, with a "+N" tail. */
function joinNames(names: string[]): string {
  const shown = names
    .slice(0, MAX_NAMES)
    .map((name) => (name.length > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 1)}…` : name))
    .join(', ');
  return names.length > MAX_NAMES ? `${shown} +${names.length - MAX_NAMES}` : shown;
}

/**
 * Why a PR needs the operator, in the same first-match order as
 * `computePRRecommendation` so the first reason explains the column the PR
 * sits in. Returns every applicable reason; callers usually show the first
 * as a chip and the rest on expand. Merged/closed PRs and PRs with an active
 * worker return no reasons: nothing is being asked of the operator.
 */
export function prAttentionReasons(pr: PRStatus): PRAttentionReason[] {
  if (pr.prState !== 'OPEN' || pr.workerActive) return [];
  const reasons: PRAttentionReason[] = [];
  if (pr.mergeConflict)
    reasons.push({
      kind: 'conflict',
      label: 'Merge conflict',
      detail:
        'The branch conflicts with its base; update the branch before CI or review can settle.',
      tone: 'fail',
    });
  if (pr.anyFailed)
    reasons.push({
      kind: 'ci-failed',
      label: pr.failedNames.length ? `CI failed: ${joinNames(pr.failedNames)}` : 'CI failed',
      detail: pr.failedNames.length
        ? `Failing watched checks: ${pr.failedNames.join(', ')}.`
        : 'At least one watched check failed.',
      tone: 'fail',
    });
  const actionable = pr.actionableBotComments.length;
  if (actionable > 0)
    reasons.push({
      kind: 'bot-comments',
      label: `${actionable} bot comment${actionable === 1 ? '' : 's'} to address`,
      detail: `Unresolved automated review comments from ${joinNames([
        ...new Set(pr.actionableBotComments.map((c) => c.author)),
      ])}.`,
      tone: 'warn',
    });
  if (pr.reviewDecision === 'CHANGES_REQUESTED')
    reasons.push({
      kind: 'changes-requested',
      label: 'Changes requested by reviewer',
      detail:
        'A human reviewer asked for changes on GitHub. Address the feedback, then re-request review.',
      tone: 'fail',
    });
  // Not a watched check, so it never drives the recommendation: always listed
  // after whatever does, so the first chip explains the column. It leads only
  // when it is the sole thing worth saying.
  const unwatched: PRAttentionReason | undefined =
    !pr.anyFailed && pr.allFailedNames?.length
      ? {
          kind: 'ci-failed',
          label: `Unwatched check failed: ${joinNames(pr.allFailedNames)}`,
          detail: `Failing checks outside the watched set: ${pr.allFailedNames.join(', ')}.`,
          tone: 'warn',
        }
      : undefined;
  if (reasons.length) return unwatched ? [...reasons, unwatched] : reasons;
  if (pr.reviewDecision === 'REVIEW_REQUIRED')
    reasons.push({
      kind: 'review-required',
      label: 'Waiting for review',
      detail: 'GitHub still requires reviews before this PR can merge.',
      tone: 'warn',
    });
  // Count and names come from the same set: watched checks when any are
  // running, otherwise every GitHub check.
  const watchedPending = pr.checks.filter((c) => c.status === 'pending').map((c) => c.name);
  const pendingCount = pr.checkSummary.pending || pr.allCheckSummary?.pending || 0;
  const pendingNames = pr.checkSummary.pending ? watchedPending : (pr.allPendingNames ?? []);
  if (pendingCount > 0)
    reasons.push({
      kind: 'ci-pending',
      label: `${pendingCount} check${pendingCount === 1 ? '' : 's'} running`,
      detail: pendingNames.length
        ? `Still running: ${pendingNames.join(', ')}.`
        : 'CI has not finished yet.',
      tone: 'muted',
    });
  if (!reasons.length && pr.allPassed && pr.reviewDecision === 'APPROVED')
    reasons.push({
      kind: 'ready',
      label: 'Approved, CI green',
      detail: 'Nothing is blocking this PR; merge when ready.',
      tone: 'ok',
    });
  if (unwatched) reasons.push(unwatched);
  return reasons;
}
