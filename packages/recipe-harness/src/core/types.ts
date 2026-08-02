import type {
  RecipeActionManifestDocument,
  RecipeArtifactManifestEntry,
  RecipeExecutionApproval,
  RecipeExecutionCapability,
  RecipeExecutionPlan,
  RecipeFailureCause,
  RecipeResolutionDocument,
  RecipeSourceProvenance,
  UiObserverRef,
} from '@farmslot/protocol';

export type RecipeRunStatus = 'pass' | 'fail' | 'unknown';
export type RecipeVideoRecordingMode = 'off' | 'full-run';

export interface RecipeRunRequest {
  recipePath?: string;
  recipeDocument?: unknown;
  artifactsDir: string;
  projectRoot?: string;
  env?: Record<string, string | undefined>;
  /** Disable ambient process inheritance when the caller supplies the complete execution environment. */
  inheritProcessEnv?: boolean;
  recordVideo?: boolean | RecipeVideoRecordingMode | RecipeVideoRecordingOptions;
  /** Provenance assigned by the caller; omitted sources receive unknown trust. */
  source?: RecipeSourceProvenance;
  /** Out-of-band approval bound to the fully resolved execution-plan digest. */
  approval?: RecipeExecutionApproval;
  /** Root recipe parameters. Defaults from paramsSchema are applied first. */
  params?: Record<string, unknown>;
  /** Active adapter used to select adapter-specific recipe files. */
  adapter?: string;
  /** Ordered recipe library sources; the first source declaring a recipe ref wins. */
  librarySources?: RecipeLibrarySource[];
}

export interface RecipeLibrarySource {
  /** Source name used in resolution output. Defaults to the directory basename. */
  name?: string;
  /** Library root directory containing recipes/ and optionally runner-owned manifests/actions. */
  root: string;
  /** Trust comes from caller configuration, never from library contents. */
  provenance?: RecipeSourceProvenance;
}

export interface LoadedRecipeLibrarySource {
  name: string;
  root: string;
  recipeCount: number;
  provenance: RecipeSourceProvenance;
}

export interface RecipeShadowEntry {
  ref: string;
  /** Winning source. */
  source: string;
  /** Catalog file path relative to the winning source's root. */
  file: string;
  /** Source names shadowed at lower precedence. */
  shadows: string[];
}

export interface RecipeLibrarySummary {
  sources: LoadedRecipeLibrarySource[];
  /** Every cross-source shadowing in the resolution, used or not. */
  shadowed: RecipeShadowEntry[];
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
  record: 'full_run';
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
  case?: string;
  output?: unknown;
  artifacts?: RecipeArtifactManifestEntry[];
  phases?: RecipeActionPhase[];
  observations?: RecipeObservations;
  observationWarnings?: RecipeObservationWarning[];
}

export interface RecipeActionPhase {
  phase: 'start' | 'move' | 'end';
  x: number;
  y: number;
  elapsedMs: number;
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
  resolveSourceDigest?: () => Promise<string>;
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

export interface RecipeCallTrace {
  ref: string;
  digest: string;
  source: string;
  file: string;
  adapter?: string;
}

export interface ArtifactWriter {
  copyRecipe(recipe: unknown): Promise<string>;
  copyResolvedRecipe(digest: string, recipe: unknown): Promise<string>;
  writeRecipeResolution(resolution: RecipeResolutionDocument): Promise<string>;
  register(entry: RecipeArtifactManifestEntry): void;
  list(): RecipeArtifactManifestEntry[];
  write(status: RecipeRunStatus, runner?: RecipeRunnerProvenance): Promise<string>;
}

export interface TraceEntry {
  nodeId: string;
  action: string;
  recipe?: RecipeCallTrace;
  intent?: string;
  proves?: string[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  ok: boolean;
  cause_class?: RecipeFailureCause;
  next?: string;
  status?: RecipeRunStatus;
  case?: string;
  output?: unknown;
  phases?: RecipeActionPhase[];
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
  cause_counts: Record<RecipeFailureCause, number>;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  harness: {
    name: '@farmslot/recipe-harness';
    version: string;
    action_manifest_schema: string;
  };
  runner?: RecipeRunnerProvenance;
  /** Present when recipe library sources were configured for the run. */
  recipeLibraries?: RecipeLibrarySummary;
}

export interface SummaryWriter {
  write(summary: SummaryDocument): Promise<string>;
}
