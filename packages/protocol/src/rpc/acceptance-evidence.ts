import type { AssessmentResult } from '../contracts/index.js';

export interface AcceptanceEvidenceGetParams {
  runId: string;
  criterionId: string;
}
export interface AcceptanceEvidenceAnalyzeParams extends AcceptanceEvidenceGetParams {
  expectedSnapshotHash: string;
}
export interface AcceptanceEvidenceResult {
  eligible: boolean;
  reason?:
    | 'disabled'
    | 'not-found'
    | 'non-textual'
    | 'no-text-evidence'
    | 'not-admitted'
    | 'stale'
    | 'provider-unavailable'
    | 'price-unavailable'
    | 'budget-exhausted'
    | 'assessment-pending'
    | 'assessment-unavailable';
  snapshotHash?: string;
  criterion?: { id: string; text: string };
  evidence?: Array<{ id: string; text: string }>;
  assessment?: AssessmentResult;
  verdict?: 'supported' | 'contradicted' | 'insufficient';
}
