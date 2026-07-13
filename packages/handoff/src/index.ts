/**
 * @farmslot/handoff - reference implementation of the Learning Package Format v1.
 *
 * The format spec ships as JSON Schema assets under `schemas/`; this package
 * provides the matching TypeScript types, the reference validator, the
 * fail-closed scrubber, the assembler/writer pair, the one override-resolution
 * engine, and the task-io/pr-publish boundary helpers. The schemas, not this
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
  type WriteConsent,
  writeLearningPackage,
  type WriteLearningPackageOptions,
  type WriteResult,
} from './learning-package/index.js';
export {
  buildPrPackage,
  type BuildPrPackageOptions,
  type BuildPrPackageResult,
  type PrEvidenceItem,
  publishPrEvidence,
  type PublishPrEvidenceOptions,
  type PublishPrEvidenceResult,
} from './pr-publish/index.js';
export {
  resolveContent,
  type ResolveContext,
  type ResolvedContent,
  resolveFile,
  type ResolveRequest,
} from './resolve/index.js';
export {
  type FloorHit,
  type FloorPattern,
  type RedactionTokens,
  type RetainedTextFile,
  scanForFloorSecrets,
  scrubFiles,
  type ScrubInputFile,
  type ScrubOptions,
  type ScrubOutcome,
} from './scrub/index.js';
export {
  deriveTaskKey,
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
  type TaskKeyInput,
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
  extractTaskDocument,
  type RawTaskSource,
  type RenderContext,
  renderTaskMarkdown,
  type RenderTaskMarkdownOptions,
  type RenderTaskMarkdownResult,
  type TaskIoConfig,
} from './task-io/index.js';
export {
  isValidRunSlug,
  type SchemaError,
  validateAgainstSchema,
  validateLearningPackage,
  type ValidateResult,
} from './validate/index.js';
