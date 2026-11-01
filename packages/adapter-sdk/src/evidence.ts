/** The shared package-validation surface used by CLI, gateway and both review clients. */
export type {
  EvidenceReviewArtifact,
  EvidenceReviewClaim,
  EvidenceReviewClaimDisplay,
  EvidenceReviewClaimOffers,
  EvidenceReviewClip,
  EvidenceReviewComparisonFilter,
  EvidenceReviewComparisonMedia,
  EvidenceReviewComparisonRow,
  EvidenceReviewComparisonTransform,
  EvidenceReviewComparisonViewRow,
  EvidenceReviewContext,
  EvidenceReviewGateSnapshot,
  EvidenceReviewInput,
  EvidenceReviewJudgmentRow,
  EvidenceReviewMediaType,
  EvidenceReviewModel,
  EvidenceReviewOccurrence,
  EvidenceReviewPlaybackEffect,
  EvidenceReviewProofKind,
  EvidenceReviewRecordingInput,
  EvidenceReviewRecordingSelection,
  EvidenceReviewSelection,
  EvidenceReviewTiming,
} from './evidence-review-model.js';
export { createEvidenceReviewModel, runEvidencePending } from './evidence-review-model.js';
export type {
  EvidenceReviewReport,
  RecordingEvidenceReadRequest,
} from './evidence-review-source.js';
export { loadRecordingEvidenceReview, readEvidenceReviewReport } from './evidence-review-source.js';
export type { EvidenceReviewIssue, EvidenceReviewPackageStatus } from './evidence-review-status.js';
export type { EvidenceReviewTimelineGroup } from './evidence-review-timeline.js';
export { formatEvidenceReviewVideoTime } from './evidence-review-timeline.js';
export type { EvidenceReviewTocEntry, ProofStepGroup } from './evidence-review-toc.js';
export {
  adjacentEvidenceReviewClaim,
  evidenceReviewToc,
  OTHER_PROOF_STEPS,
  proofStepGroups,
} from './evidence-review-toc.js';
export type { RecipeValidationResult, RecordedEvidencePackageInput } from '@farmslot/protocol';
export type { RecordedClaimSource } from '@farmslot/recipe-runner/evidence';
export {
  deriveReviewedRecipeClaims,
  recordedClaimSources,
  selectedRecipeClaims,
  validateRecordedEvidencePackage,
} from '@farmslot/recipe-runner/evidence';
