/** Portable evidence validation; importing this entry does not load capture or filesystem code. */
export { proofDocument } from './assertions.js';
export type { RecipeComparisonCapture, RecipeComparisonCaptureRow } from './capture-comparisons.js';
export { groupRecipeCaptureComparisons } from './capture-comparisons.js';
export type { OccurrenceRecordingCoverage } from './moments.js';
export { indexRecordingTimelines, occurrenceRecordingCoverage } from './moments.js';
export type { RecordedClaimSource } from './package.js';
export {
  deriveReviewedRecipeClaims,
  recordedClaimSources,
  selectedRecipeClaims,
  validateRecordedEvidencePackage,
} from './package.js';
export { planRecipeEvidence } from './plan.js';
export type { RecordedEvidencePackageInput } from '@farmslot/protocol';
