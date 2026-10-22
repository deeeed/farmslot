export type ReviewRecommendation = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
export type ReviewSeverity = 'blocker' | 'major' | 'minor' | 'nit';
export interface ReviewApprovalPolicy {
  maxNits: number;
  minorVerdict: ReviewRecommendation;
  majorVerdict: ReviewRecommendation;
}
export interface ReviewSeverityFinding {
  severity?: string;
}
export function isReviewSeverity(value: unknown): value is ReviewSeverity;
export const DEFAULT_APPROVAL_POLICY: Readonly<ReviewApprovalPolicy>;
export function resolveApprovalPolicy(value?: unknown): ReviewApprovalPolicy;
export function reviewRecommendation(
  findings: readonly ReviewSeverityFinding[],
  policy?: Partial<ReviewApprovalPolicy>,
): ReviewRecommendation;
export function assertReviewRecommendation(
  findings: readonly ReviewSeverityFinding[],
  recommendation: unknown,
  policy?: Partial<ReviewApprovalPolicy>,
): ReviewRecommendation;
export function renderApprovalPolicy(policy?: Partial<ReviewApprovalPolicy>): string;
export class ReviewApprovalPolicyError extends Error {
  code: 'REVIEW_POLICY_CONFLICT';
  recommendation: ReviewRecommendation;
  constructor(recommendation: ReviewRecommendation);
}

export function normalizeReviewSeverity(value: unknown): ReviewSeverity;
export function renderReviewResultInstructions(resultPath: string): string;
