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
    // A plain comment neither grants nor clears a verdict on GitHub; only
    // APPROVED and DISMISSED (or a fresh CHANGES_REQUESTED) move it.
    if (review.state === 'PENDING' || review.state === 'COMMENTED') continue;
    const previous = latest.get(review.author);
    if (!previous || Date.parse(review.submittedAt) >= Date.parse(previous.submittedAt)) {
      latest.set(review.author, review);
    }
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

/** `gh api --paginate --slurp` returns one JSON array per page; flatten them. */
export function parseReviewPages(stdout: string): PrReviewSummary[] {
  const pages = JSON.parse(stdout) as GhReview[][];
  return pages.flat().map((row) => ({
    // Bots are tagged here and filtered in reviewersToRerequest; the two are
    // one contract (GitHub marks apps with user.type, not with a login suffix).
    author: row.user?.type === 'Bot' ? `${row.user?.login ?? ''}[bot]` : (row.user?.login ?? ''),
    state: row.state ?? '',
    submittedAt: row.submitted_at ?? '',
  }));
}

export async function listPrReviews(ciRepo: string, prNumber: number): Promise<PrReviewSummary[]> {
  const result = await ghRequest(
    ['api', `repos/${ciRepo}/pulls/${prNumber}/reviews?per_page=100`, '--paginate', '--slurp'],
    { force: true },
  );
  return parseReviewPages(result.stdout);
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
 * CHANGES_REQUESTED. Returns the logins re-requested; never throws: a
 * failed lookup or re-request is logged and leaves the PR as it was, since
 * this is a courtesy to reviewers and not part of the round's own work.
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
    // One request per reviewer: GitHub rejects the whole batch when a single
    // login cannot be requested (no repository access), which would silence
    // every eligible reviewer along with it.
    const requested: string[] = [];
    for (const login of reviewers) {
      try {
        await ghRequest(
          [
            'api',
            '-X',
            'POST',
            `repos/${ciRepo}/pulls/${prNumber}/requested_reviewers`,
            '-f',
            `reviewers[]=${login}`,
          ],
          { force: true },
        );
        requested.push(login);
      } catch (error) {
        console.warn(
          `${logPrefix} could not re-request ${login} on ${ciRepo}#${prNumber}: ${(error as Error).message}`,
        );
      }
    }
    if (requested.length > 0) {
      console.log(
        `${logPrefix} re-requested review on ${ciRepo}#${prNumber} from ${requested.join(', ')}`,
      );
    }
    return requested;
  } catch (error) {
    console.warn(
      `${logPrefix} could not re-request review on ${ciRepo}#${prNumber}: ${(error as Error).message}`,
    );
    return [];
  }
}
