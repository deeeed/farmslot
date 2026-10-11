/** The shared package-validation surface used by CLI, gateway and both review clients. */
export type { RecipeValidationResult, RecordedEvidencePackageInput } from '@farmslot/protocol';
export {
  readRecordedEvidencePackage,
  type RecordedEvidencePackageReadCheck,
  type RecordedEvidencePackageReadResult,
  validateRecordedEvidencePackage,
} from '@farmslot/recipe-runner/evidence';
