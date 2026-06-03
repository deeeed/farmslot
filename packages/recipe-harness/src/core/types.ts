import type { RecipeActionManifestDocument, RecipeArtifactManifestEntry } from '@farmslot/protocol';

export type RecipeRunStatus = 'pass' | 'fail' | 'unknown';

export interface RecipeRunRequest {
  recipePath?: string;
  recipeDocument?: unknown;
  artifactsDir: string;
  projectRoot?: string;
  env?: Record<string, string | undefined>;
}

export interface RecipeRunResult {
  status: RecipeRunStatus;
  summaryPath: string;
  tracePath: string;
  artifactManifestPath: string;
  recipePath: string;
}

export interface RecipeRunner {
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
  preconditions?: PreconditionChecker[];
  logger?: RecipeLogger;
  hud?: RecipeHudOptions | false;
  runner?: RecipeRunnerProvenance;
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
  registerArtifact(entry: RecipeArtifactManifestEntry): void;
  logger: RecipeLogger;
}

export interface ActionAdapter {
  action: string;
  testOnly?: boolean;
  execute(node: Record<string, unknown>, context: ActionExecutionContext): Promise<ActionResult>;
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
  output?: unknown;
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
}

export interface SummaryWriter {
  write(summary: SummaryDocument): Promise<string>;
}
