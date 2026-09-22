import type {
  AssessmentFeedbackParams,
  AssessmentJsonValue,
  AssessmentRecord,
} from './assessment.js';

export type FailureTriageCause =
  | 'environment'
  | 'dependencies'
  | 'implementation'
  | 'test_harness'
  | 'missing_evidence'
  | 'external_service'
  | 'unclear';

export interface FailureTriageGetParams {
  runId: string;
  step?: string;
  includeEvidence?: boolean;
}
export interface FailureTriageAnalyzeParams extends FailureTriageGetParams {
  /** The ready view's immutable snapshot identity; stale clicks cannot export new data. */
  snapshotHash: string;
  retryOf?: string;
}
export type FailureTriageFeedbackParams = AssessmentFeedbackParams;

export interface FailureTriageView {
  runId: string;
  step?: string;
  availability:
    | 'ready'
    | 'disabled'
    | 'no-recorded-failure'
    | 'missing-key'
    | 'unsupported-model'
    | 'rejected-data'
    | 'budget-blocked'
    | 'unavailable';
  reason: string;
  provider?: string;
  model?: string;
  snapshotHash?: string;
  record?: AssessmentRecord;
  input?: AssessmentJsonValue;
  stale: boolean;
  /** Gateway-derived eligibility; retries always require an explicit request. */
  retryAllowed: boolean;
  advice?: {
    cause: FailureTriageCause;
    /** Identifier for a fixed read-only diagnostic. Never an executable command. */
    nextCheck: string;
    evidence: Array<{ id: string; sourceId: string; digest: string }>;
  };
  efficiencyClaim: 'not_established';
}
