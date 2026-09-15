import { prReviewReadiness } from './pr-review-status.js';
import type { PRWorkspaceEntry } from './pr-workspace.js';

/**
 * What the viewer has to do next on a PR in the Need Review section, in the
 * order the list shows them. Derived from the configured review account's last
 * review versus the PR head (PRReviewObservation) and, when no observation
 * exists yet, from GitHub's overall review decision.
 */
export const PR_REVIEW_QUEUE_GROUPS = [
  'Re-review: author pushed since',
  'Not reviewed yet',
  'Waiting on author',
  'Reviewed by you',
  'Not ready',
  'Review status unknown',
] as const;
export type PRReviewQueueGroup = (typeof PR_REVIEW_QUEUE_GROUPS)[number];

export interface PRReviewQueueItem {
  group: PRReviewQueueGroup;
  /** Short chip text. */
  label: string;
  /** One sentence for the row and tooltip. */
  detail: string;
  tone: 'warn' | 'ok' | 'fail' | 'muted';
}

export function prReviewQueue(entry: PRWorkspaceEntry): PRReviewQueueItem {
  const readiness = prReviewReadiness(entry);
  const observation = readiness.observation;
  const status = entry.status;
  // Live PR status wins over an older observation: a PR merged since the last
  // review check must not route through the open-PR branches.
  const liveState =
    status?.prState === 'MERGED' ? 'merged' : status?.prState === 'CLOSED' ? 'closed' : undefined;
  const state = liveState ?? observation?.state ?? 'open';
  if (state !== 'open')
    return {
      group: 'Not ready',
      label: state === 'merged' ? 'Merged' : 'Closed',
      detail: `This PR is ${state}.`,
      tone: 'muted',
    };
  if (observation?.draft)
    return {
      group: 'Not ready',
      label: 'Draft',
      detail: 'The author has not marked it ready for review.',
      tone: 'muted',
    };

  if (observation) {
    const who = `@${observation.reviewer}`;
    const review = observation.review;
    const atHead = review?.commit === observation.headSha;
    if (observation.requested)
      return {
        group: review ? 'Re-review: author pushed since' : 'Not reviewed yet',
        label: review ? 'Re-review requested' : 'Review requested',
        detail: `GitHub is asking ${who} for a review${review ? ' again' : ''}.`,
        tone: 'warn',
      };
    if (observation.decision === 'APPROVED' && review?.state !== 'CHANGES_REQUESTED')
      // GitHub's requirements are satisfied; a head that moved since the
      // viewer's approval does not reopen the queue (prReviewBlockedReason
      // says the same). An explicit re-request was handled above.
      return {
        group: 'Reviewed by you',
        label: review?.state === 'APPROVED' ? 'Approved' : 'Approved by others',
        detail:
          review?.state === 'APPROVED'
            ? `${who} approved and GitHub's requirements are satisfied${atHead ? '' : ', even though the head moved since'}.`
            : `GitHub's review requirements are satisfied without ${who}.`,
        tone: 'ok',
      };
    if (review && !atHead && review.state === 'CHANGES_REQUESTED')
      return {
        group: 'Re-review: author pushed since',
        label: 'Author pushed a fix',
        detail: `${who} requested changes; commits landed since. Check whether the feedback is addressed.`,
        tone: 'warn',
      };
    if (review && atHead && review.state === 'CHANGES_REQUESTED')
      return {
        group: 'Waiting on author',
        label: 'You requested changes',
        detail: `${who} requested changes on the current commit; nothing new to review.`,
        tone: 'muted',
      };
    if (review && atHead && review.state === 'APPROVED')
      return {
        group: 'Reviewed by you',
        label: observation.decision === 'APPROVED' ? 'Approved' : 'Approved, others still required',
        detail:
          observation.decision === 'APPROVED'
            ? `${who} approved the current commit and GitHub's requirements are satisfied.`
            : `${who} approved the current commit; GitHub still requires other reviews.`,
        tone: 'ok',
      };
    if (review && atHead)
      return {
        group: 'Reviewed by you',
        label: 'Commented',
        detail: `${who} commented on the current commit without a verdict.`,
        tone: 'ok',
      };
    if (review && !atHead)
      return {
        group: 'Re-review: author pushed since',
        label: 'New commits since your review',
        detail: `${who} last reviewed ${review.commit?.slice(0, 7) ?? 'an older commit'}; the head moved.`,
        tone: 'warn',
      };
    if (observation.decision === 'APPROVED')
      return {
        group: 'Reviewed by you',
        label: 'Approved by others',
        detail: `GitHub's review requirements are satisfied without ${who}.`,
        tone: 'ok',
      };
    return {
      group: 'Not reviewed yet',
      label: 'Not reviewed yet',
      detail: `${who} has not reviewed this PR.`,
      tone: 'warn',
    };
  }

  // No observation for a configured review account: fall back to GitHub's overall decision.
  switch (status?.reviewDecision) {
    case 'APPROVED':
      return {
        group: 'Reviewed by you',
        label: 'Approved',
        detail: "GitHub's review requirements are satisfied.",
        tone: 'ok',
      };
    case 'CHANGES_REQUESTED':
      return status?.pushedAfterChangesRequested
        ? {
            group: 'Re-review: author pushed since',
            label: 'Author pushed since changes requested',
            detail:
              'Commits landed after the changes-requested review; check whether the feedback is addressed.',
            tone: 'warn',
          }
        : {
            group: 'Waiting on author',
            label: 'Changes requested',
            detail: 'A reviewer requested changes; your own review status is unknown.',
            tone: 'fail',
          };
    case 'REVIEW_REQUIRED':
      return {
        group: 'Not reviewed yet',
        label: 'Reviews required',
        detail: 'GitHub requires more reviews; your own review status is unknown.',
        tone: 'warn',
      };
    default:
      return {
        group: 'Review status unknown',
        label: 'Unknown',
        detail: readiness.detail,
        tone: 'muted',
      };
  }
}
