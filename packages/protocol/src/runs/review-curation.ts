import type { PRReviewThread } from '../contracts/reviews.js';
import type { ReviewGatePayload, ReviewLineComment, RunReviewResult } from '../contracts/runs.js';
import { digestRecipeDocument } from '../recipe/digest.js';

export function reviewCommentKey(comment: ReviewLineComment): string {
  return `${comment.path}\u0000${comment.line}\u0000${comment.body}`;
}

export function reviewCommentsByFile(
  comments: readonly ReviewLineComment[],
): Map<string, ReviewLineComment[]> {
  const map = new Map<string, ReviewLineComment[]>();
  for (const comment of comments) {
    const list = map.get(comment.path) ?? [];
    list.push(comment);
    map.set(comment.path, list);
  }
  return map;
}

export function reviewCommentCountByFile(
  commentsByFile: ReadonlyMap<string, readonly ReviewLineComment[]>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const [path, comments] of commentsByFile) {
    map.set(path, comments.length);
  }
  return map;
}

export function reviewThreadsForFile(
  commentsByFile: ReadonlyMap<string, readonly ReviewLineComment[]>,
  filePath: string,
  timestamp: () => string = () => new Date().toISOString(),
): PRReviewThread[] {
  const comments = commentsByFile.get(filePath) ?? [];
  return comments.map((comment, index) => ({
    id: `review-${index}-${comment.line}`,
    path: comment.path,
    line: comment.line,
    resolved: false,
    outdated: false,
    comments: [
      {
        id: index,
        body: `**[${comment.severity}]** ${comment.body}`,
        author: 'Review Agent',
        createdAt: timestamp(),
        updatedAt: timestamp(),
      },
    ],
  }));
}

export const REVIEW_POST_RECOMMENDATIONS = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] as const;
export type ReviewPostRecommendation = (typeof REVIEW_POST_RECOMMENDATIONS)[number];

export function reviewPostRecommendation(
  payload: Pick<ReviewGatePayload, 'recommendation'>,
): ReviewPostRecommendation {
  const value = payload.recommendation?.trim().toUpperCase();
  return value === 'APPROVE' || value === 'REQUEST_CHANGES' ? value : 'COMMENT';
}

/** Bind user choices to content, excluding refresh times and transient artifact URLs. */
export function reviewPostingFingerprint(payload: RunReviewResult): string {
  const snapshot = payload.reviewSnapshot;
  return digestRecipeDocument([
    snapshot?.baseSha ?? null,
    snapshot?.headSha ?? null,
    snapshot?.diffHash ?? null,
    snapshot?.untrackedFiles ?? [],
    payload.reviewMd,
    payload.recommendation,
    payload.lineComments,
  ]);
}

export interface ReviewCurationState {
  reviewFingerprint: string;
  includedIndices: number[];
  recommendation: ReviewPostRecommendation;
  includeEvidence: boolean;
}

export function createReviewCuration(payload: ReviewGatePayload): ReviewCurationState {
  return {
    reviewFingerprint: reviewPostingFingerprint(payload),
    includedIndices: payload.lineComments.map((_, index) => index),
    recommendation: reviewPostRecommendation(payload),
    includeEvidence: true,
  };
}

export function toggleReviewFinding(
  state: ReviewCurationState,
  index: number,
): ReviewCurationState {
  return {
    ...state,
    includedIndices: state.includedIndices.includes(index)
      ? state.includedIndices.filter((value) => value !== index)
      : [...state.includedIndices, index].sort((a, b) => a - b),
  };
}

export function reviewCurationView(payload: ReviewGatePayload, state: ReviewCurationState) {
  return {
    fingerprint: reviewPostingFingerprint(payload),
    reviewedSha: payload.reviewSnapshot?.headSha?.trim() || null,
    findings: payload.lineComments.map((comment, index) => ({
      ...comment,
      index,
      included: state.includedIndices.includes(index),
    })),
    includedCount: state.includedIndices.length,
    recommendation: state.recommendation,
    evidenceAvailable: Boolean(payload.evidenceMarkdown?.trim()),
    includeEvidence: state.includeEvidence,
    reportNote: 'Selection controls finding comments. The original review report stays unchanged.',
  };
}

export function assertReviewCurationFresh(
  payload: RunReviewResult,
  selection?: Record<string, unknown>,
): void {
  const fingerprint = selection?.reviewFingerprint;
  if (
    fingerprint !== undefined &&
    (typeof fingerprint !== 'string' || fingerprint !== reviewPostingFingerprint(payload))
  ) {
    throw Object.assign(new Error('Review changed. Inspect the current review before posting.'), {
      code: 'REVIEW_CHANGED',
    });
  }
}

/** Existing publication selection semantics, shared with both client models. */
export function selectReviewFindings(
  result: RunReviewResult,
  selection: Record<string, unknown>,
): RunReviewResult {
  assertReviewCurationFresh(result, selection);
  const recommendation = selection.recommendation ?? result.recommendation;
  if (
    typeof recommendation !== 'string' ||
    !REVIEW_POST_RECOMMENDATIONS.includes(recommendation as ReviewPostRecommendation)
  )
    throw new Error('Invalid selected review recommendation');
  const indices = selection.includedIndices;
  if (
    indices !== undefined &&
    (!Array.isArray(indices) ||
      indices.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= result.lineComments.length,
      ))
  )
    throw new Error('Invalid selected review comments');
  return {
    ...result,
    recommendation,
    lineComments:
      indices === undefined
        ? result.lineComments
        : result.lineComments.filter((_, index) => (indices as number[]).includes(index)),
  };
}

export interface ReviewedSourceLine {
  number: number;
  text: string;
  target: boolean;
}
export interface ReviewedFindingContext {
  available: boolean;
  note: string;
  lines: ReviewedSourceLine[];
}
export function reviewedFindingContext(content: string, line: number): ReviewedFindingContext {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!Number.isSafeInteger(line) || line < 1 || line > lines.length)
    return {
      available: false,
      note: 'Finding line is unavailable in the reviewed revision.',
      lines: [],
    };
  const start = Math.max(1, line - 4),
    end = Math.min(lines.length, line + 4);
  return {
    available: true,
    note: '',
    lines: lines
      .slice(start - 1, end)
      .map((text, index) => ({ number: start + index, text, target: start + index === line })),
  };
}
