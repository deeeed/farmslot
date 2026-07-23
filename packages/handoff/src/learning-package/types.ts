import type { ScrubOptions } from '../scrub/scrubber.js';
import type {
  ArtifactKind,
  Manifest,
  ManifestRun,
  ManifestTask,
  ResolutionSource,
  ScrubReport,
  SourceDocument,
  VisualPassAttestation,
} from '../spec/types.js';

/**
 * Local context for an assembly. Generic: no tool-chain specifics. `stagingRoot`
 * is the local directory under which the assembler stages a package (or, when the
 * scrub gate blocks, a quarantine dir). Nothing here is repo- or network-bound.
 */
export interface HandoffContext {
  /** Local root under which packages and quarantine dirs are staged. */
  stagingRoot: string;
  /** $FARMSLOT_HOME - personal tier root, redacted to a token in stored paths. */
  farmslotHome?: string;
  /** Farm repo root - farm/domain tier (any farm repo, not tool-chain-specific). */
  farmRoot?: string;
  /** Run workspace dir (source of raw artifacts), redacted to a token in paths. */
  workspace?: string;
  /** Non-silent resolution/shadow log sink. */
  logger?: (event: ResolutionSource) => void;
}

/**
 * Normalized run metadata. Upstream (the typed gateway path) produces these
 * already PII-scrubbed; the assembler stamps them into manifest.json +
 * source.json.
 */
export interface RunMeta {
  /** Equals the run-slug (spec section 1) and manifest.packageId. */
  packageId: string;
  project: string;
  repo?: string;
  /** Domain/team tier key; empty string when none. */
  domain: string;
  run: ManifestRun;
  task: ManifestTask;
  /** Normalized source fields for source.json (work-only, per spec section 3.2).
   * `sourceKind` comes from `task.sourceKind`; the assembler stamps both. */
  source?: Partial<Omit<SourceDocument, 'schemaVersion' | 'sourceKind'>>;
  /** Open manifest extensions. */
  extensions?: Record<string, unknown>;
}

/** Rendered task-document location (fleet layout). */
export interface TaskDocPaths {
  /** Absolute path to the rendered TASK.md. MUST exist. */
  taskMd: string;
}

/** A raw harness output directory to fold in post-scrub as harness/<name>/*. */
export interface HarnessOutputDir {
  name: string;
  dir: string;
}

/** Artifact-input locations (fleet layout). */
export interface ArtifactPaths {
  /** Absolute path; MUST contain report.md + learnings.md. */
  artifactsDir: string;
  /** Raw runner output dirs, folded in post-scrub. */
  harnessOutputDirs?: HarnessOutputDir[];
  /**
   * Absolute path to the run's canonical grade.json (human verdict), when the
   * run was graded. Copied verbatim (post-scrub) into the package as
   * `grade.json`. Absent input = absent file, still a valid package.
   */
  gradeJson?: string;
}

/**
 * A media artifact offered to the gate with its already-resolved selection state.
 * The caller supplies evidence-manifest selection and the agent visual-pass
 * attestation; the assembler enforces the media policy (spec section 5.1 layer 4).
 */
export interface MediaInput {
  absolutePath: string;
  packagePath: string;
  kind: Extract<ArtifactKind, 'screenshot' | 'video'>;
  evidenceManifestSelected: boolean;
  visualPass?: VisualPassAttestation;
}

/** Input to `assembleLearningPackage` (fleet layout). */
export interface LearningPackageInput {
  /** Producer surface; open vocabulary per spec section 1. */
  surface: string;
  runRecord: RunMeta;
  /** Resolution audit for provenance.json (spec section 4.3). */
  templateProvenance: ResolutionSource[];
  taskDoc: TaskDocPaths;
  artifacts: ArtifactPaths;
  /** Evidence-manifest-selected media with resolved visual-pass state. */
  media?: MediaInput[];
  /**
   * Resolved farm/personal scrub configuration applied during assembly.
   * UNION-only (spec section 5.1 layer 5): extra deny patterns ADD to the
   * crypto-secret floor; nothing here can loosen it.
   */
  scrub?: ScrubOptions;
}

/**
 * Discriminated result. `ok` sets `packageDir` (and never `quarantineDir`);
 * `blocked` sets `quarantineDir` (and never `packageDir`). A blocked result is a
 * type-level barrier: it can never be passed to a repo write.
 */
export type AssembleResult =
  | { status: 'ok'; packageDir: string; manifest: Manifest; scrubReport: ScrubReport }
  | { status: 'blocked'; quarantineDir: string; scrubReport: ScrubReport };
