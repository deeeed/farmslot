import type { PRReviewObservation } from '../contracts/pr-rules.js';

/** A negative gate only: satisfying this check never authorizes a run. */
export function prReviewBlockedReason(
  observation: PRReviewObservation | undefined,
): string | undefined {
  if (!observation) return undefined;
  if (observation.state !== 'open') return `This PR is ${observation.state}; no review is needed.`;
  if (observation.draft) return 'This PR is still a draft.';
  // A fresh, explicit GitHub re-request can ask for another review on the same commit.
  if (observation.requested) return undefined;
  if (observation.decision === 'APPROVED')
    return 'GitHub review requirements are already satisfied.';
  const review = observation.review;
  if (
    review &&
    ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED'].includes(review.state) &&
    review.commit === observation.headSha
  )
    return `@${observation.reviewer} already reviewed the current commit. A new review is unnecessary until the head changes or GitHub requests another review.`;
  return undefined;
}
