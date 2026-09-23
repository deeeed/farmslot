import type { AssessmentResult, PendingDecision } from '../contracts/index.js';

export interface DecisionResolveParams {
  decisionId: string;
  actionId: string;
}
export interface DecisionListResult {
  decisions: PendingDecision[];
}

/** An explicitly requested, advisory-only assessment of existing gateway actions. */
export interface DecisionAdviceGetParams {
  runId: string;
  decisionId: string;
}
export interface DecisionAdviceAnalyzeParams extends DecisionAdviceGetParams {
  expectedSnapshotHash: string;
}
export interface DecisionAdviceResult {
  eligible: boolean;
  reason?:
    | 'disabled'
    | 'not-pending'
    | 'insufficient-options'
    | 'not-admitted'
    | 'stale'
    | 'provider-unavailable'
    | 'price-unavailable'
    | 'budget-exhausted'
    | 'assessment-unavailable'
    | 'assessment-pending';
  snapshotHash?: string;
  assessment?: AssessmentResult;
  recommendedActionId?: string;
  abstained?: boolean;
}

/** Stop actions are never the two alternatives a decision advisor compares. */
export function isDecisionAdviceDeclineAction(id: string): boolean {
  return /^(abort|cancel)(?:[-_]|$)/i.test(id);
}
