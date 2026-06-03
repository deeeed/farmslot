import type { PRStatus } from '../contracts/index.js';

export interface PRStatusParams {
  pr: number;
  project?: string;
  /** Bypass the 30s gh-cache and re-fetch from GitHub. */
  force?: boolean;
}

export interface PRListParams {
  project?: string;
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
}
export interface PRStatusResult {
  pr: PRStatus;
}

export interface PRListResult {
  prs: PRStatus[];
}
