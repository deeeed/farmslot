import type {
  RecipeActionManifestDocument,
  RecipeArtifactManifestEntry,
  RecipeExecutionApproval,
  RecipeExecutionCapability,
  RecipeExecutionPlan,
  RecipeSourceProvenance,
  UiObserverRef,
} from '@farmslot/protocol';

export type RecipeRunStatus = 'pass' | 'fail' | 'unknown';
export type RecipeVideoRecordingMode = 'off' | 'full-run';
export type RecipeRecordPolicy = 'none' | 'trace_only' | 'proof_window' | 'failure_only';

export interface RecipeRunRequest {
  recipePath?: string;
  recipeDocument?: unknown;
  artifactsDir: string;
  projectRoot?: string;
  env?: Record<string, string | undefined>;
  recordVideo?: boolean | RecipeVideoRecordingMode | RecipeVideoRecordingOptions;
  /** Provenance assigned by the caller; omitted sources receive unknown trust. */
  source?: RecipeSourceProvenance;
  /** Out-of-band approval bound to the fully resolved execution-plan digest. */
  approval?: RecipeExecutionApproval;
  /** Ordered recipe library sources; the first source declaring a flow ref wins. */
  librarySources?: RecipeLibrarySource[];
}

export interface RecipeLibrarySource {
  /** Source name used in resolution output. Defaults to library.json name, then the directory basename. */
  name?: string;
  /** Library root directory containing library.json and flows/. */
  root: string;
  /** Trust comes from caller configuration, never from library.json. */
  provenance?: RecipeSourceProvenance;
}

export interface LoadedRecipeLibrarySource {
  name: string;
  root: string;
  flowCount: number;
  provenance: RecipeSourceProvenance;
}

export interface RecipeFlowResolutionEntry {
  ref: string;
  source: string;
  /** Catalog file path relative to the library root. */
  file: string;
  /** Source names that also declare this ref at lower precedence. */
  shadows?: string[];
  lastVerified?: string;
}

export interface RecipeFlowOverrideEntry {
  ref: string;
  /** Library source whose declaration the recipe-local flow overrode. */
  source: string;
}

export interface RecipeFlowShadowEntry {
  ref: string;
  /** Winning source. */
  source: string;
  /** Catalog file path relative to the winning source's root. */
  file: string;
  /** Source names shadowed at lower precedence. */
  shadows: string[];
}

export interface RecipeFlowResolutionSummary {
  sources: LoadedRecipeLibrarySource[];
  used: RecipeFlowResolutionEntry[];
  /** Recipe-local declarations that overrode a library-provided ref. */
  overrides: RecipeFlowOverrideEntry[];
  /** Every cross-source shadowing in the resolution, used or not. */
  shadowed: RecipeFlowShadowEntry[];
}

export interface RecipeRunResult {
  status: RecipeRunStatus;
  summaryPath: string;
  tracePath: string;
  artifactManifestPath: string;
  recipePath: string;
}

export interface RecipeRunner {
  /** Resolve and authorize the exact execution plan without running actions or writing artifacts. */
  preflight(request: RecipeRunRequest): Promise<RecipeExecutionPlan>;
  run(request: RecipeRunRequest): Promise<RecipeRunResult>;
}

export interface RecipeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RecipeRunnerProvenance {
  source: string;
  git_ref: string;
  name?: string;
  version?: string;
}

export interface CreateRecipeRunnerOptions {
  actionManifest: RecipeActionManifestDocument;
  adapters: ActionAdapter[];
  /** Caller-owned default provenance. Omit to fail closed with unknown trust. */
  defaultSource?: RecipeSourceProvenance;
  preconditions?: PreconditionChecker[];
  logger?: RecipeLogger;
  hud?: RecipeHudOptions | false;
  runner?: RecipeRunnerProvenance;
  recording?: RecipeRecordingOptions;
  /** Capabilities denied when recipe or implementation provenance is not trusted. */
  blockedCapabilities?: RecipeExecutionCapability[];
}

export interface RecipeVideoRecordingOptions {
  mode?: RecipeVideoRecordingMode;
  maxFps?: number;
  maxSize?: number;
  target?: RecordingTarget;
}

export interface RecipeRecordingOptions {
  targetProvider?: RecordingTargetProvider;
  videoRecorder?: VideoRecorder;
}

export interface RecordingTargetProvider {
  resolveRecordingTarget(context: RecordingTargetContext): Promise<RecordingTarget>;
}

export interface RecordingTargetContext {
  nodeId: string;
  node: Record<string, unknown>;
  recipe: unknown;
  projectRoot: string;
  artifactsDir: string;
  env: Record<string, string | undefined>;
  scope?: 'run' | 'node';
}

export type RecordingTarget =
  | { kind: 'window-id'; windowId: string }
  | { kind: 'pid'; pid: number }
  | { kind: 'app-window'; appName: string; windowName: string }
  | { kind: 'simulator'; device: string };

export interface VideoRecorderStartRequest {
  outputPath: string;
  target: RecordingTarget;
  maxFps?: number;
  maxSize?: number;
  nodeId: string;
  record: RecipeRecordPolicy | 'full_run';
}

export interface ActiveVideoRecording {
  stop(): Promise<VideoRecordingResult>;
}

export interface VideoRecordingResult {
  recorder?: RecipeArtifactManifestEntry['recorder'];
}

export interface VideoRecorder {
  name: string;
  version?: string;
  platform?: string;
  doctor?(): Promise<VideoRecorderDoctorResult>;
  start(request: VideoRecorderStartRequest): Promise<ActiveVideoRecording>;
}

export interface VideoRecorderDoctorResult {
  ok: boolean;
  code: string;
  message: string;
  suggestedFix?: string;
}

export interface RecipeHudOptions {
  enabled?: boolean;
  title?: string;
  display?: RecipeHudDisplayOptions;
}

export interface RecipeHudDisplayOptions {
  layout?: 'bottom-bar' | 'docked-bottom' | 'card';
  position?: 'bottom' | 'top' | 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
  showTitle?: boolean;
  /** Show node/action/proof metadata. Hidden by default because HUD copy is for humans, not trace/debug labels. */
  showDebug?: boolean;
  /** Show authored detail as a second HUD line. Hidden by default because detail is trace/review metadata, not the current intent. */
  showDetail?: boolean;
  maxDetailLines?: number;
  width?: string;
}

export interface ActionResult {
  status?: RecipeRunStatus;
  next?: string;
  case?: string;
  output?: unknown;
  artifacts?: RecipeArtifactManifestEntry[];
  observations?: RecipeObservations;
  observationWarnings?: RecipeObservationWarning[];
}

export interface ActionExecutionContext {
  nodeId: string;
  recipe: unknown;
  projectRoot: string;
  artifactsDir: string;
  env: Record<string, string | undefined>;
  outputs: ReadonlyMap<string, unknown>;
  getOutput(nodeId: string): unknown;
  resolveProjectPath(relativePath: string): string;
  resolveArtifactPath(relativePath: string): string;
  getRunFileOffset(relativePath: string): number | undefined;
  registerArtifact(entry: RecipeArtifactManifestEntry): void;
  logger: RecipeLogger;
}

export interface ActionAdapter {
  action: string;
  testOnly?: boolean;
  capabilities?: RecipeExecutionCapability[];
  source?: RecipeSourceProvenance;
  execute(node: Record<string, unknown>, context: ActionExecutionContext): Promise<ActionResult>;
  observe?(
    refs: readonly UiObserverRef[],
    node: Record<string, unknown>,
    context: ActionExecutionContext,
  ): Promise<RecipeObservationResult>;
}

export type RecipeObservations = Partial<Record<UiObserverRef, unknown>>;

export interface RecipeObservationWarning {
  ref: UiObserverRef;
  message: string;
}

export interface RecipeObservationResult {
  observations?: RecipeObservations;
  warnings?: RecipeObservationWarning[];
}

export interface RecipePreconditionGate {
  id: string;
  description?: string;
  params?: Record<string, unknown>;
  required?: boolean;
}

export interface PreconditionResult {
  ok?: boolean;
  output?: unknown;
  failureKind?: string;
  error?: string;
}

export interface PreconditionChecker {
  id: string;
  capabilities?: RecipeExecutionCapability[];
  source?: RecipeSourceProvenance;
  execute(
    gate: RecipePreconditionGate,
    context: ActionExecutionContext,
  ): Promise<PreconditionResult | boolean | undefined>;
}

export interface ArtifactWriter {
  copyRecipe(recipe: unknown): Promise<string>;
  register(entry: RecipeArtifactManifestEntry): void;
  list(): RecipeArtifactManifestEntry[];
  write(status: RecipeRunStatus, runner?: RecipeRunnerProvenance): Promise<string>;
}

export interface TraceEntry {
  nodeId: string;
  action: string;
  intent?: string;
  phase?: string;
  record?: unknown;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  ok: boolean;
  next?: string;
  status?: RecipeRunStatus;
  case?: string;
  output?: unknown;
  observations?: RecipeObservations;
  observationWarnings?: RecipeObservationWarning[];
  artifacts?: RecipeArtifactManifestEntry[];
  error?: string;
}

export interface TraceWriter {
  record(entry: TraceEntry): void;
  list(): TraceEntry[];
  write(): Promise<string>;
}

export interface SummaryDocument {
  status: RecipeRunStatus;
  total: number;
  passed: number;
  failed: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  harness: {
    name: '@farmslot/recipe-harness';
    version: string;
    runner_protocol_version: number;
    action_registry_version: number;
  };
  runner?: RecipeRunnerProvenance;
  /** Present when recipe library sources were configured for the run. */
  flowResolution?: RecipeFlowResolutionSummary;
}

export interface SummaryWriter {
  write(summary: SummaryDocument): Promise<string>;
}
