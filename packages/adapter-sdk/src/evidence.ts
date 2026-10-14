/** The shared package-validation surface used by CLI, gateway and both review clients. */
export type {
  EvidenceReviewArtifact,
  EvidenceReviewClaim,
  EvidenceReviewClip,
  EvidenceReviewComparisonFilter,
  EvidenceReviewComparisonMedia,
  EvidenceReviewComparisonRow,
  EvidenceReviewComparisonTransform,
  EvidenceReviewContext,
  EvidenceReviewGateSnapshot,
  EvidenceReviewInput,
  EvidenceReviewMediaType,
  EvidenceReviewModel,
  EvidenceReviewOccurrence,
  EvidenceReviewPlaybackEffect,
  EvidenceReviewProofKind,
  EvidenceReviewRecordingInput,
  EvidenceReviewSelection,
  EvidenceReviewTiming,
} from './evidence-review-model.js';
export { createEvidenceReviewModel } from './evidence-review-model.js';
export type {
  EvidenceReviewReport,
  RecordingEvidenceReadRequest,
} from './evidence-review-source.js';
export { loadRecordingEvidenceReview, readEvidenceReviewReport } from './evidence-review-source.js';
export type { EvidenceReviewIssue, EvidenceReviewPackageStatus } from './evidence-review-status.js';
export type { RecipeValidationResult, RecordedEvidencePackageInput } from '@farmslot/protocol';
export {
  deriveReviewedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/recipe-runner/evidence';
