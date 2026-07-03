/**
 * @farmslot/handoff - reference implementation of the Learning Package Format v1.
 *
 * The format spec ships as JSON Schema assets under `schemas/`; this package
 * provides the matching TypeScript types, the reference validator, the
 * fail-closed scrubber, and the fleet-layout assembler. The schemas, not this
 * code, are the authority: any producer whose output validates is conformant.
 */
export {
  type ArtifactPaths,
  assembleLearningPackage,
  type AssembleResult,
  type HandoffContext,
  type HarnessOutputDir,
  type LearningPackageInput,
  type MediaInput,
  type RunMeta,
  type TaskDocPaths,
} from './learning-package/index.js';
export {
  type FloorHit,
  type RedactionTokens,
  type RetainedTextFile,
  scanForFloorSecrets,
  scrubFiles,
  type ScrubInputFile,
  type ScrubOutcome,
} from './scrub/index.js';
export {
  type JsonSchema,
  loadAllSchemas,
  loadSchema,
  REQUIRED_FILES,
  RUN_SLUG_PATTERN,
  SCHEMA_NAMES,
  SCHEMA_VERSION,
  type SchemaName,
  SCRUB_FLOOR_VERSION,
  SPEC_VERSION,
} from './spec/index.js';
export type {
  ArtifactKind,
  ArtifactRecord,
  ArtifactsIndex,
  IndexRow,
  Manifest,
  ManifestRun,
  ManifestTask,
  Provenance,
  PrPublication,
  ResolutionSource,
  ResolutionTier,
  RunOutcome,
  ScrubReport,
  ScrubStatus,
  SourceDocument,
  SourceKind,
  VisualPassAttestation,
} from './spec/types.js';
export {
  isValidRunSlug,
  type SchemaError,
  validateAgainstSchema,
  validateLearningPackage,
  type ValidateResult,
} from './validate/index.js';
