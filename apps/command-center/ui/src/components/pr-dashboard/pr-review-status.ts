import type { PRReviewIntent, PRReviewObservation } from '@farmslot/protocol';
import { prReviewBlockedReason } from '@farmslot/protocol';

import type { PRWorkspaceEntry } from './pr-workspace.js';

export interface PRReviewReadiness {
  label: string;
  group:
    | 'Needs review'
    | 'Changes requested'
    | 'Approved'
    | 'Not ready for review'
    | 'Review status unknown';
  tone: 'warn' | 'ok' | 'fail' | 'muted';
  detail: string;
  personal: string;
  blockedReason?: string;
  observation?: PRReviewObservation;
}
export function reviewRunLabel(status: PRReviewIntent['status'] | undefined): string {
  return status
    ? {
        held: 'Awaiting manual start',
        'needs-configuration': 'Not configured',
        queued: 'Queued',
        running: 'Running',
        completed: 'Completed',
        failed: 'Failed',
        withdrawn: 'Withdrawn',
      }[status]
    : 'Request pending';
}
export function prReviewReadiness(entry: PRWorkspaceEntry): PRReviewReadiness {
  const byReviewer = new Map<string, PRReviewObservation>();
  for (const observation of entry.reviewObservations) {
    const previous = byReviewer.get(observation.reviewer.toLowerCase());
    if (!previous || Date.parse(observation.observedAt) > Date.parse(previous.observedAt))
      byReviewer.set(observation.reviewer.toLowerCase(), observation);
  }
  const observations = [...byReviewer.values()].sort(
    (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
  );
  const observation = observations[0];
  const decision = observation ? observation.decision : entry.status?.reviewDecision;
  let personal =
    byReviewer.size > 1 ? 'Multiple configured review accounts' : 'Your review status is unknown';
  if (byReviewer.size === 1 && observation) {
    const who = `@${observation.reviewer}`;
    const review = observation.review;
    personal = observation.requested
      ? `Review requested from ${who}`
      : review?.commit === observation.headSha &&
          ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED'].includes(review.state)
        ? `${who} already reviewed this commit`
        : review?.commit && review.commit !== observation.headSha
          ? `New commits since ${who}'s review`
          : !review
            ? `No submitted review from ${who}`
            : `${who}: ${review.state.toLowerCase().replaceAll('_', ' ')}`;
  }
  const blockedReason = observations.map(prReviewBlockedReason).find(Boolean);
  const result = (
    label: string,
    group: PRReviewReadiness['group'],
    tone: PRReviewReadiness['tone'],
    detail: string,
    blocked = blockedReason,
  ): PRReviewReadiness => ({
    label,
    group,
    tone,
    detail,
    personal,
    blockedReason: blocked,
    observation,
  });
  if (observation?.state === 'merged' || entry.status?.merged || entry.status?.prState === 'MERGED')
    return result(
      'Merged',
      'Not ready for review',
      'muted',
      'This PR has merged.',
      'This PR is merged; no review is needed.',
    );
  if (observation?.state === 'closed' || (!observation && entry.status?.prState === 'CLOSED'))
    return result(
      'Closed',
      'Not ready for review',
      'muted',
      'This PR is closed.',
      'This PR is closed; no review is needed.',
    );
  if (observation?.draft)
    return result(
      'Draft',
      'Not ready for review',
      'muted',
      'The author has not marked this PR ready for review.',
      'This PR is still a draft.',
    );
  if (decision === 'APPROVED')
    return result(
      'Approved',
      'Approved',
      'ok',
      'GitHub reports that its review requirements are satisfied.',
      observation?.requested
        ? undefined
        : (blockedReason ?? 'GitHub review requirements are already satisfied.'),
    );
  if (decision === 'REVIEW_REQUIRED')
    return result(
      'Reviews required',
      'Needs review',
      'warn',
      'GitHub reports that more reviews are required. Existing approval from you does not need to be repeated.',
    );
  if (decision === 'CHANGES_REQUESTED')
    return result(
      'Changes requested',
      'Changes requested',
      'fail',
      'GitHub reports outstanding requested changes.',
    );
  return result(
    'Review status unknown',
    'Review status unknown',
    'muted',
    'GitHub has not supplied an overall review requirement. A team-rule match alone does not mean a review is needed.',
  );
}
