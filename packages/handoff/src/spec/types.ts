/**
 * TypeScript types for the Learning Package Format v1. These conform to the JSON
 * Schemas shipped under `schemas/` (the schemas, not these types, are the
 * authority). The `extensions` open objects and unknown-value tolerance mirror
 * the closed-core / open-extension design principle.
 */

export type RunOutcome = 'success' | 'failed' | 'aborted' | 'partial';
export type SourceKind = 'text' | 'file' | 'github-pr' | 'github-issue' | 'jira';
export type ResolutionTier = 'personal' | 'domain' | 'farm' | 'default';
export type ScrubStatus = 'pass' | 'blocked';

export interface RunnerRef {
  name?: string;
  package?: string;
  version?: string;
}

export interface ManifestRun {
  startedAt: string;
  finishedAt?: string;
  flow: string;
  outcome: RunOutcome;
  runner?: RunnerRef;
  model?: string;
  harnessSchemaVersion?: number | string;
}

export interface ManifestTask {
  title: string;
  sourceKind: SourceKind;
  ticket?: string;
  sourceRef?: string;
}

export interface ManifestFileRecord {
  sha256: string;
  bytes?: number;
  role?: 'required' | 'optional';
}

export interface ManifestScrubbing {
  status: ScrubStatus;
  scrubReport: 'scrub-report.json';
  floorVersion?: number;
}

export interface Manifest {
  schemaVersion: 1;
  packageId: string;
  /** Cross-attempt task-family key (spec section 1): derived, never assigned. */
  taskKey: string;
  surface: string;
  project: string;
  repo?: string;
  domain: string;
  engineer: string;
  run: ManifestRun;
  task: ManifestTask;
  files: Record<string, ManifestFileRecord>;
  scrubbing: ManifestScrubbing;
  extensions?: Record<string, unknown>;
}

export interface SourceDocument {
  schemaVersion: 1;
  sourceKind: SourceKind;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  labels?: string[];
  ticket?: string;
  status?: string;
  priority?: string;
  sourceRef?: string;
  extensions?: Record<string, unknown>;
}

export interface ResolutionShadow {
  path: string;
  tier: ResolutionTier;
}

export interface ResolutionSource {
  kind: string;
  resolvedPath: string;
  tier: ResolutionTier;
  shadows: ResolutionShadow[];
}

export interface Provenance {
  schemaVersion: 1;
  resolutions: ResolutionSource[];
}

export type ArtifactKind =
  | 'summary'
  | 'trace'
  | 'artifact-manifest'
  | 'recipe'
  | 'quality'
  | 'screenshot'
  | 'video'
  | 'diff'
  | 'other';

export interface ArtifactRecord {
  path: string;
  sha256: string;
  originSha256?: string;
  bytes?: number;
  kind: ArtifactKind;
  origin?: string;
  evidenceManifestSelected?: boolean;
  visualPassCleared?: boolean;
}

export interface ArtifactsIndex {
  schemaVersion: 1;
  artifacts: ArtifactRecord[];
}

export interface ScrubBlockedRecord {
  file: string;
  kind: string;
  fingerprint?: string;
}

export interface ScrubRedactionRecord {
  file: string;
  kind: string;
  count: number;
}

export type OmitReason =
  | 'disallowed-type'
  | 'unscannable'
  | 'media-not-selected'
  | 'media-no-attestation'
  | 'media-visual-block'
  | 'oversize';

export interface ScrubOmittedRecord {
  path: string;
  reason: OmitReason;
}

export interface VisualPassAttestation {
  file: string;
  passedAt: string;
  attestedBy: string;
  finding: 'clear' | 'redacted';
}

export interface ScrubReport {
  schemaVersion: 1;
  status: ScrubStatus;
  scannedAt: string;
  floorVersion: number;
  blocked: ScrubBlockedRecord[];
  redactions: ScrubRedactionRecord[];
  omitted: ScrubOmittedRecord[];
  visualPassAttestations: VisualPassAttestation[];
  extensions?: Record<string, unknown>;
}

export interface PrConsent {
  githubWrite: boolean;
  publicUpload: boolean;
  grantedAt: string;
}

export interface PrPublication {
  schemaVersion: 1;
  prRef?: string;
  publishedAt?: string;
  uploaded?: { path: string; url: string; sha256?: string }[];
  consent?: PrConsent;
  extensions?: Record<string, unknown>;
}

export interface IndexRow {
  schemaVersion: 1;
  packageId: string;
  /** Matches manifest.taskKey; keys indexes/by-task/<taskKey>.jsonl. */
  taskKey: string;
  packagePath: string;
  surface: string;
  project: string;
  domain: string;
  engineer: string;
  flow: string;
  ticket?: string;
  outcome: RunOutcome;
  startedAt: string;
  finishedAt?: string;
  packageSchemaVersion?: number;
  hasPr?: boolean;
  hasHarnessEvidence?: boolean;
}
