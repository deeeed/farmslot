import type { PRStatus } from '../contracts/index.js';

export interface PRStatusParams {
  pr: number;
  project?: string;
  /** Bypass the 30s gh-cache and re-fetch from GitHub. */
  force?: boolean;
}

export interface PRListParams {
  project?: string;
  /** Bypass the gateway's warm list and refetch every PR from GitHub before answering. */
  force?: boolean;
}

export interface PRReviewCommentsParams {
  pr: number;
  repo: string;
}

export interface PRReviewCommentsResult {
  threads: import('../contracts/index.js').PRReviewThread[];
  currentUser: string;
}

export interface PRAddCommentParams {
  pr: number;
  repo: string;
  body: string;
  path: string;
  line: number;
  side?: 'LEFT' | 'RIGHT';
  /** Exact reviewed commit for a frozen diff. Defaults to the PR's current head. */
  commitId?: string;
  inReplyTo?: number;
}

export interface PRAddCommentResult {
  id: number;
}

export interface PRResolveThreadParams {
  repo: string;
  threadId: string;
  resolved: boolean;
}

export interface PRResolveThreadResult {
  ok: boolean;
}

export interface PREditCommentParams {
  repo: string;
  commentId: number;
  body: string;
}

export interface PREditCommentResult {
  ok: boolean;
}

export interface PRDeleteCommentParams {
  repo: string;
  commentId: number;
}

export interface PRDeleteCommentResult {
  ok: boolean;
}

export interface PRSubmitReviewParams {
  pr: number;
  repo: string;
  body: string;
}

export interface PRSubmitReviewResult {
  id: number;
}

export interface PRForSlotParams {
  slotId: string;
}

export interface PRForSlotResult {
  pr: number | null;
  repo: string | null;
  /** Pull request base branch, or the project's configured default when no PR exists. */
  baseRef: string;
}
export interface PRStatusResult {
  pr: PRStatus;
}

export interface PRListResult {
  prs: PRStatus[];
  /** ISO time the served list was fetched from GitHub. Absent only when no list exists yet. */
  fetchedAt?: string;
  /** True when the gateway answered from its warm list while a GitHub refresh is still running. */
  refreshing?: boolean;
}
