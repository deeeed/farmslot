import type { ReviewLineComment } from '../contracts/runs.js';
import { digestRecipeDocument } from '../recipe/digest.js';

/** Inspection only. A location never changes finding inclusion or publication. */
export interface ReviewCommentLocation {
  file: string;
  line?: number;
  comment?: string;
  head?: string;
}

function commentIdentity(comment: ReviewLineComment): string {
  return digestRecipeDocument({ path: comment.path, line: comment.line, body: comment.body });
}

export function reviewCommentLocation(
  comment: ReviewLineComment,
  head?: string,
): ReviewCommentLocation {
  return { file: comment.path, line: comment.line, comment: commentIdentity(comment), head };
}

export function reviewCommentIndex(
  comments: readonly ReviewLineComment[],
  location: ReviewCommentLocation,
  head?: string,
): number {
  if (!location.comment || (location.head && location.head !== head)) return -1;
  return comments.findIndex(
    (comment) =>
      comment.path === location.file &&
      comment.line === location.line &&
      commentIdentity(comment) === location.comment,
  );
}

export function parseReviewCommentLocation(
  params: URLSearchParams,
): ReviewCommentLocation | undefined {
  const file = params.get('commentFile');
  if (!file) return undefined;
  const line = Number(params.get('commentLine'));
  return {
    file,
    line: Number.isSafeInteger(line) && line > 0 ? line : undefined,
    comment: params.get('comment') || undefined,
    head: params.get('commentHead') || undefined,
  };
}

export function writeReviewCommentLocation(
  params: URLSearchParams,
  location: ReviewCommentLocation | null,
): void {
  for (const [key, value] of Object.entries({
    commentFile: location?.file,
    commentLine: location?.line?.toString(),
    comment: location?.comment,
    commentHead: location?.head,
  })) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
}
