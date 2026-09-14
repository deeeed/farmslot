// run-completion/review-rerequest.ts — after a farm round updates a PR, put
// it back in front of the reviewers who asked for changes.
//
// A pr-complete round replies to and resolves review threads and pushes
// fixes, but GitHub keeps a reviewer's CHANGES_REQUESTED verdict until that
// reviewer looks again, and nobody was re-requesting them. PRs sat on
// "changes requested" for days after the farm had addressed every thread.
// Finalize now re-requests every reviewer whose latest review is
// CHANGES_REQUESTED, so the PR reappears in their queue.

import { ghRequest } from '../integrations/github-client.js';

export interface PrReviewSummary {
  author: string;
  state: string;
  submittedAt: string;
}

/**
 * Reviewers whose latest review still stands at CHANGES_REQUESTED. The PR
 * author and bots never count; a reviewer who later approved, dismissed, or
 * left a newer comment is not re-requested.
 */
export function reviewersToRerequest(
  reviews: readonly PrReviewSummary[],
  prAuthor: string | null,
): string[] {
  const latest = new Map<string, PrReviewSummary>();
  for (const review of reviews) {
    if (!review.author || review.author === prAuthor) continue;
    if (review.author.endsWith('[bot]')) continue;
    if (review.state === 'PENDING') continue;
    const previous = latest.get(review.author);
    if (!previous || review.submittedAt >= previous.submittedAt) latest.set(review.author, review);
  }
  return [...latest.entries()]
    .filter(([, review]) => review.state === 'CHANGES_REQUESTED')
    .map(([author]) => author)
    .sort();
}

interface GhReview {
  user?: { login?: string; type?: string } | null;
  state?: string;
  submitted_at?: string;
}

export async function listPrReviews(ciRepo: string, prNumber: number): Promise<PrReviewSummary[]> {
  const result = await ghRequest(
    ['api', `repos/${ciRepo}/pulls/${prNumber}/reviews?per_page=100`, '--paginate'],
    { force: true },
  );
  const rows = result.stdout
    .trim()
    .split(/\n(?=\[)/)
    .flatMap((chunk) => (chunk.trim() ? (JSON.parse(chunk) as GhReview[]) : []));
  return rows.map((row) => ({
    author: row.user?.type === 'Bot' ? `${row.user?.login ?? ''}[bot]` : (row.user?.login ?? ''),
    state: row.state ?? '',
    submittedAt: row.submitted_at ?? '',
  }));
}

export async function prAuthorLogin(ciRepo: string, prNumber: number): Promise<string | null> {
  const result = await ghRequest(
    ['api', `repos/${ciRepo}/pulls/${prNumber}`, '--jq', '.user.login'],
    { force: true },
  );
  return result.stdout.trim() || null;
}

/**
 * Re-request review from every reviewer whose verdict is still
 * CHANGES_REQUESTED. Returns the logins re-requested; never throws, a
 * failed re-request is logged and leaves the PR as it was.
 */
export async function rerequestChangesRequestedReviewers(
  ciRepo: string,
  prNumber: number,
  logPrefix: string,
): Promise<string[]> {
  try {
    const [reviews, author] = await Promise.all([
      listPrReviews(ciRepo, prNumber),
      prAuthorLogin(ciRepo, prNumber),
    ]);
    const reviewers = reviewersToRerequest(reviews, author);
    if (reviewers.length === 0) return [];
    await ghRequest(
      [
        'api',
        '-X',
        'POST',
        `repos/${ciRepo}/pulls/${prNumber}/requested_reviewers`,
        ...reviewers.flatMap((login) => ['-f', `reviewers[]=${login}`]),
      ],
      { force: true },
    );
    console.log(
      `${logPrefix} re-requested review on ${ciRepo}#${prNumber} from ${reviewers.join(', ')}`,
    );
    return reviewers;
  } catch (error) {
    console.warn(
      `${logPrefix} could not re-request review on ${ciRepo}#${prNumber}: ${(error as Error).message}`,
    );
    return [];
  }
}
