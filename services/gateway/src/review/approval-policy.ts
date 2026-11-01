import {
  resolveApprovalPolicy,
  type ReviewRecommendation,
} from '@farmslot/protocol/review-approval-policy.cjs';
import { invalidateProjectVarsCache } from '@farmslot/slot-config';

import { loadProjectVars } from '../core/config.js';

/** Completion and refresh must see project policy edits without a restart. */
export async function loadReviewApprovalPolicy(project: string) {
  invalidateProjectVarsCache(project);
  try {
    return resolveApprovalPolicy((await loadProjectVars(project)).projectJson.approvalPolicy);
  } catch (error) {
    // Legacy and ad hoc review rows without a project pack inherit the shared defaults.
    if (error instanceof Error && error.message.startsWith('Project config not found:'))
      return resolveApprovalPolicy();
    throw error;
  }
}

const REVIEW_RECOMMENDATION_RANK: Record<ReviewRecommendation, number> = {
  APPROVE: 0,
  COMMENT: 1,
  REQUEST_CHANGES: 2,
};

function isReviewRecommendation(value: string): value is ReviewRecommendation {
  return Object.hasOwn(REVIEW_RECOMMENDATION_RANK, value);
}

/** A known recommendation, case-insensitive, or null. */
export function normalizeReviewRecommendation(value: unknown): ReviewRecommendation | null {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return isReviewRecommendation(normalized) ? normalized : null;
}

export function stricterReviewRecommendation(
  left: ReviewRecommendation,
  right: ReviewRecommendation,
): ReviewRecommendation {
  return REVIEW_RECOMMENDATION_RANK[right] > REVIEW_RECOMMENDATION_RANK[left] ? right : left;
}
