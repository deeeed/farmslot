export interface CICheck {
  name: string;
  status: 'pass' | 'fail' | 'pending' | 'skipped';
  watchName: string;
}

export interface BotComment {
  author: string;
  label: string;
  action: string;
  bodyPreview: string;
  /** Digest of the complete comment body; used when previews are truncated. */
  bodyFingerprint?: string;
  createdAt: string;
  source: string;
  workerResponded: boolean;
}

export type PRRecommendation =
  | 'WORKING'
  | 'NEEDS_ATTENTION'
  | 'IN_REVIEW'
  | 'READY'
  | 'WAITING_FOR_MERGE'
  | 'MERGED'
  | 'CLOSED_WITHOUT_MERGE';

export type PRFamilyWorkflowState = 'active' | 'complete' | 'failed';
export type PRFamilyMergeState =
  | 'not_applicable'
  | 'waiting_for_merge'
  | 'merged'
  | 'closed_without_merge';

/** A reviewer's standing verdict: the review that still counts toward reviewDecision. */
export interface PRReviewVerdict {
  reviewer: string;
  /** APPROVED | CHANGES_REQUESTED (GitHub `latestOpinionatedReviews`). */
  state: string;
  submittedAt: string | null;
}

export interface PRStatus {
  pr: number;
  author?: string;
  title: string;
  summary: string | null;
  repo: string;
  /** Head branch name (e.g. `fix/proj-2802`). Forwarded from `gh pr view`; null when unknown. */
  headRef: string | null;
  project: string;
  slot: string | null;
  session: string | null;
  checks: CICheck[];
  checkSummary: {
    passed: number;
    failed: number;
    pending: number;
    skipped: number;
    total: number;
  };
  allCheckSummary?: {
    passed: number;
    failed: number;
    pending: number;
    skipped: number;
    total: number;
  };
  allPendingNames?: string[];
  allFailedNames?: string[];
  allPassed: boolean;
  anyFailed: boolean;
  failedNames: string[];
  botComments: BotComment[];
  actionableBotComments: BotComment[];
  prState: 'OPEN' | 'CLOSED' | 'MERGED';
  createdAt?: string | null;
  updatedAt?: string | null;
  closedAt?: string | null;
  mergedAt?: string | null;
  merged: boolean;
  mergeable: string;
  mergeConflict: boolean;
  reviewDecision: string;
  /**
   * Each reviewer's standing verdict. Later plain comments from the same
   * reviewer do not replace it, which is why this is not `latestReviews`.
   */
  reviewVerdicts?: PRReviewVerdict[];
  /** Reviewers GitHub is still waiting on: team slugs and user logins. */
  reviewRequests?: { teams: string[]; users: string[] };
  /**
   * A commit landed after the newest CHANGES_REQUESTED review and no later
   * verdict replaced it: the author may have addressed the feedback and is
   * waiting for a re-review.
   */
  pushedAfterChangesRequested?: boolean;
  recommendation: PRRecommendation;
  /** True when a dispatch worker is actively running against this PR. */
  workerActive?: boolean;
  ownedFamily?: boolean;
  familyId?: string | null;
  familyRootTicketOrPr?: string | null;
  familyRunCount?: number;
  activeFamilyRunCount?: number;
  workflowState?: PRFamilyWorkflowState;
  mergeState?: PRFamilyMergeState;
  latestRunId?: string | null;
}

// ─── PR Review Comments ───

export interface PRReviewThread {
  id: string;
  path: string;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  comments: PRReviewComment[];
}

export interface PRReviewComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

// Review contracts collect publication, review-gate, and cross-review shapes.
export {
  APPROVE_PUBLISH_UNRESOLVED_ACTION,
  independentReviewFixRetriesExhausted,
  independentReviewMatchesPreparedPackage,
  independentReviewRetryCapReason,
  independentReviewRetryCount,
  latestExhaustedIndependentReview,
  latestIndependentReview,
  stampIndependentReviewRetryCap,
} from '../runs/review-retries.js';
export type {
  CommentsTriageSummary,
  IndependentReviewAttempt,
  IndependentReviewStatus,
  PublicationStatus,
  PublicationTarget,
  ReviewDiffSnapshot,
  ReviewFixDeltaSnapshot,
  ReviewGatePayload,
  ReviewLineComment,
  ReviewLoopTimelineSegment,
  ReviewLoopTimelineSegmentKind,
  ReviewRunnerId,
  ReviewValidationDepth,
  RunnerSessionUsage,
} from './runs.js';
export {
  isReviewValidationDepth,
  REVIEW_VALIDATION_DEPTHS,
  reviewValidationDepthForLoop,
} from './runs.js';
