import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  getRecipeActionManifestActionNames,
  type RecipeActionManifestDocument,
  type RecipeArtifactManifestEntry,
  type RecipeExecutionPlan,
  validateRecipeArtifactPackage,
} from '@farmslot/protocol';

import { JsonArtifactWriter, JsonSummaryWriter, JsonTraceWriter } from '../node/writers.js';
import {
  createCaptureHelperVideoRecorder,
  errorMessage,
  manifestTarget,
} from '../recording/capture-helper.js';

import {
  type ResolvedRecipeDependencies,
  resolveRecipeDependencies,
  rootResolutionRef,
  validateRecipeDependencyParams,
} from './compose.js';
import { executeRecipe } from './execution.js';
import { extractWorkflowGraph, type WorkflowGraph } from './graph.js';
import { buildHudNode } from './hud.js';
import { isRecord, normalizeRelativePath, readJsonFile } from './json.js';
import {
  loadRecipeLibraries,
  type RecipeLibraryResolution,
  type ResolvedLibraryRecipe,
} from './library.js';
import { resolveRecipeParams } from './parameters.js';
import { defaultObserverRefsFromManifest } from './passive-observations.js';
import { copyFileWithinRoots, statFileWithinRoot } from './path.js';
import {
  cleanupAbortedRunVideoRecording,
  removePartialRunVideoOutput,
} from './recording-cleanup.js';
import {
  buildRecipeExecutionPlan,
  enforceRecipeExecutionPlan,
  recipeSourceForRequest,
  verifyExecutableSource,
} from './trust.js';
import { RECIPE_TRUST_ENV } from './trust-input.js';
import type {
  ActionAdapter,
  ActiveVideoRecording,
  CreateRecipeRunnerOptions,
  RecipeHudOptions,
  RecipeLibrarySummary,
  RecipeLogger,
  RecipeRecordingOptions,
  RecipeRunner,
  RecipeRunRequest,
  RecipeRunResult,
  RecipeRunStatus,
  RecipeVideoRecordingOptions,
  SummaryDocument,
  VideoRecorder,
} from './types.js';
import { assertManifestIsValid, assertRecipeMatchesManifest } from './validation.js';

const HARNESS_VERSION = '0.1.0';
const RUNNER_BUILT_IN_ACTIONS = new Set(['call', 'end']);
const noopLogger: RecipeLogger = {
  info() {},
  warn() {},
  error() {},
};

interface ResolvedRecipeRun {
  projectRoot: string;
  artifactsDir: string;
  sourceRecipePath?: string;
  recipe: Record<string, unknown>;
  rootRef: string;
  params: Record<string, unknown>;
  recipeSource: ReturnType<typeof recipeSourceForRequest>;
  env: Record<string, string | undefined>;
  libraryResolution?: RecipeLibraryResolution;
  graph: WorkflowGraph;
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>;
  dependencyResolution: ResolvedRecipeDependencies;
  executionPlan: RecipeExecutionPlan;
}

export function defineActionAdapter(adapter: ActionAdapter): ActionAdapter {
  if (!adapter.action.trim()) throw new Error('Action adapter action must be a non-empty string.');
  return adapter;
}

export function createRecipeRunner(options: CreateRecipeRunnerOptions): RecipeRunner {
  assertManifestIsValid(options.actionManifest);
  const declaredActions = new Set(getRecipeActionManifestActionNames(options.actionManifest));
  const adapterMap = new Map<string, ActionAdapter>();

  for (const adapter of options.adapters) {
    if (!adapter.action.trim())
      throw new Error('Action adapter action must be a non-empty string.');
    if (!declaredActions.has(adapter.action) && adapter.testOnly !== true) {
      throw new Error(`Adapter ${adapter.action} is not declared by the recipe action manifest.`);
    }
    if (adapterMap.has(adapter.action)) {
      throw new Error(`Adapter ${adapter.action} is registered more than once.`);
    }
    adapterMap.set(adapter.action, adapter);
  }

  for (const action of declaredActions) {
    if (!adapterMap.has(action) && !RUNNER_BUILT_IN_ACTIONS.has(action)) {
      throw new Error(`Manifest action ${action} has no registered adapter.`);
    }
  }

  return new DefaultRecipeRunner(
    options.actionManifest,
    adapterMap,
    options.logger ?? noopLogger,
    options.hud,
    options.runner,
    options.recording,
    options.defaultSource,
    options.blockedCapabilities,
  );
}

function collectWatchLogPaths(paths: Set<string>, nodes: Record<string, unknown>): void {
  for (const node of Object.values(nodes)) {
    if (!isRecord(node) || node.action !== 'watch_logs' || typeof node.path !== 'string') continue;
    paths.add(normalizeRelativePath(node.path).split(path.sep).join('/'));
  }
}

async function collectRunFileOffsets({
  graph,
  recipes,
  projectRoot,
}: {
  graph: WorkflowGraph;
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>;
  projectRoot: string;
}): Promise<Map<string, number>> {
  const offsets = new Map<string, number>();
  const paths = new Set<string>();
  collectWatchLogPaths(paths, graph.nodes);
  for (const recipe of recipes.values()) {
    collectWatchLogPaths(paths, extractWorkflowGraph(recipe.document).nodes);
  }
  for (const relativePath of paths) {
    try {
      const info = await statFileWithinRoot(projectRoot, relativePath);
      offsets.set(relativePath, info.size);
    } catch (error) {
      if (!isNodeFileMissingError(error)) throw error;
      offsets.set(relativePath, 0);
    }
  }
  return offsets;
}

function isNodeFileMissingError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

class DefaultRecipeRunner implements RecipeRunner {
  readonly #actionManifest: RecipeActionManifestDocument;
  readonly #adapters: ReadonlyMap<string, ActionAdapter>;
  readonly #logger: RecipeLogger;
  readonly #defaultObserverRefs;
  readonly #hud: RecipeHudOptions | false | undefined;
  readonly #runnerProvenance: CreateRecipeRunnerOptions['runner'];
  readonly #recording: RecipeRecordingOptions | undefined;
  readonly #defaultSource: CreateRecipeRunnerOptions['defaultSource'];
  readonly #blockedCapabilities: CreateRecipeRunnerOptions['blockedCapabilities'];

  constructor(
    actionManifest: RecipeActionManifestDocument,
    adapters: ReadonlyMap<string, ActionAdapter>,
    logger: RecipeLogger,
    hud: RecipeHudOptions | false | undefined,
    runnerProvenance: CreateRecipeRunnerOptions['runner'],
    recording: RecipeRecordingOptions | undefined,
    defaultSource: CreateRecipeRunnerOptions['defaultSource'],
    blockedCapabilities: CreateRecipeRunnerOptions['blockedCapabilities'],
  ) {
    this.#actionManifest = actionManifest;
    this.#adapters = adapters;
    this.#logger = logger;
    this.#defaultObserverRefs = defaultObserverRefsFromManifest(actionManifest);
    this.#hud = hud;
    this.#runnerProvenance = runnerProvenance;
    this.#recording = recording;
    this.#defaultSource = defaultSource;
    this.#blockedCapabilities = blockedCapabilities;
  }

  async preflight(request: RecipeRunRequest): Promise<RecipeExecutionPlan> {
    const { executionPlan } = await this.#resolveRequest(request);
    enforceRecipeExecutionPlan(executionPlan, request, this.#blockedCapabilities);
    return executionPlan;
  }

  async #resolveRequest(request: RecipeRunRequest): Promise<ResolvedRecipeRun> {
    if (!request.recipePath && request.recipeDocument == null) {
      throw new Error('Recipe run requires recipePath or recipeDocument.');
    }
    const projectRoot = path.resolve(request.projectRoot ?? process.cwd());
    const artifactsDir = path.resolve(request.artifactsDir);
    const env = {
      ...(request.inheritProcessEnv === false ? {} : process.env),
      ...(request.env ?? {}),
    };
    const trustEnv = new Set<string>(Object.values(RECIPE_TRUST_ENV));
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || trustEnv.has(key)) delete env[key];
    }
    const sourceRecipePath = request.recipePath ? path.resolve(request.recipePath) : undefined;
    const recipe = request.recipeDocument ?? (await readJsonFile(sourceRecipePath!));
    if (!isRecord(recipe)) throw new Error('Recipe document must be an object.');
    const recipeSource = recipeSourceForRequest(
      request,
      recipe,
      sourceRecipePath,
      this.#defaultSource,
    );
    const libraryResolution: RecipeLibraryResolution | undefined =
      request.librarySources && request.librarySources.length > 0
        ? await loadRecipeLibraries(request.librarySources, {
            adapter: request.adapter,
            logger: this.#logger,
          })
        : undefined;
    const recipes = libraryResolution?.recipes ?? new Map<string, ResolvedLibraryRecipe>();
    const externalRecipeIds = new Set(recipes.keys());
    assertRecipeMatchesManifest(recipe, this.#actionManifest, { externalRecipeIds });
    const graph = extractWorkflowGraph(recipe);
    const rootRef = rootRecipeRef(sourceRecipePath, recipes, recipeSource.digest!);
    const dependencyResolution = resolveRecipeDependencies({
      rootRef,
      root: recipe,
      rootSource: recipeSource,
      recipes,
    });
    for (const resolved of dependencyResolution.recipes.values()) {
      assertRecipeMatchesManifest(resolved.document, this.#actionManifest, { externalRecipeIds });
    }
    const params = resolveRecipeParams(rootRef, recipe, request.params ?? {});
    validateRecipeDependencyParams({
      root: recipe,
      params,
      recipes: dependencyResolution.recipes,
    });
    const executionPlan = buildRecipeExecutionPlan({
      recipe,
      params,
      source: recipeSource,
      recipes: dependencyResolution.recipes,
      adapters: this.#adapters,
      actionManifest: this.#actionManifest,
      projectRoot,
      artifactsDir,
      env,
      hud: this.#hud,
      recordVideo: request.recordVideo,
    });
    return {
      projectRoot,
      artifactsDir,
      sourceRecipePath,
      recipe,
      rootRef,
      params,
      recipeSource,
      env,
      libraryResolution,
      graph,
      recipes: dependencyResolution.recipes,
      dependencyResolution,
      executionPlan,
    };
  }

  async run(request: RecipeRunRequest): Promise<RecipeRunResult> {
    const {
      projectRoot,
      artifactsDir,
      recipe,
      rootRef,
      params,
      env,
      libraryResolution,
      graph,
      recipes,
      dependencyResolution,
      executionPlan,
    } = await this.#resolveRequest(request);
    enforceRecipeExecutionPlan(executionPlan, request, this.#blockedCapabilities);
    const startedAt = new Date();
    await mkdir(artifactsDir, { recursive: true });
    const runFileOffsets = await collectRunFileOffsets({
      graph,
      recipes,
      projectRoot,
    });

    const artifactWriter = new JsonArtifactWriter(artifactsDir);
    const traceWriter = new JsonTraceWriter(artifactsDir, this.#runnerProvenance);
    const summaryWriter = new JsonSummaryWriter(artifactsDir);
    let outputs: ReadonlyMap<string, unknown> = new Map();
    const recipePath = await artifactWriter.copyRecipe(recipe);
    for (const dependency of dependencyResolution.recipes.values()) {
      await artifactWriter.copyResolvedRecipe(dependency.provenance.digest!, dependency.document);
    }
    await artifactWriter.writeRecipeResolution(dependencyResolution.document);
    let status: RecipeRunStatus = 'unknown';
    const videoOptions = normalizeVideoRecordingOptions(request.recordVideo);
    const videoRecorder = videoOptions.mode !== 'off' ? this.#videoRecorder() : undefined;
    let runRecording: RunVideoRecording | undefined;
    let canExecute = true;
    if (videoRecorder) {
      try {
        runRecording = await this.#startRunVideoRecording({
          recorder: videoRecorder,
          videoOptions,
          recipe,
          projectRoot,
          artifactsDir,
          env,
        });
      } catch (error) {
        const message = errorMessage(error);
        traceWriter.record({
          nodeId: 'recipe-run:video',
          action: 'record.video',
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          ok: false,
          error: message,
        });
        this.#logger.error(`record.video start failed: ${message}`);
        status = 'fail';
        canExecute = false;
      }
    }

    try {
      if (canExecute) {
        const execution = await executeRecipe({
          ref: rootRef,
          recipe,
          params,
          recipes,
          actionManifest: this.#actionManifest,
          adapters: this.#adapters,
          traceWriter,
          logger: this.#logger,
          defaultObserverRefs: this.#defaultObserverRefs,
          createContext: (nodeId, activeRecipe, activeOutputs, getOutput) =>
            this.#createExecutionContext({
              nodeId,
              recipe: activeRecipe,
              projectRoot,
              artifactsDir,
              env,
              outputs: activeOutputs,
              getOutput,
              artifactWriter,
              runFileOffsets,
            }),
          registerArtifacts: (artifacts) => {
            for (const artifact of artifacts) artifactWriter.register(artifact);
          },
          publishHudProgress: (hudStatus, event) =>
            this.#publishHudProgressOrRecord(traceWriter, hudStatus, event),
        });
        status = execution.status;
        outputs = execution.outputs;
      }

      artifactWriter.register({
        path: 'summary.json',
        type: 'summary',
        label: 'Run summary',
        category: 'system',
      });
      artifactWriter.register({
        path: 'trace.json',
        type: 'trace',
        label: 'Execution trace',
        category: 'system',
      });
      if (status === 'pass') {
        const runHudStartedAt = new Date();
        try {
          await this.#publishRunHud(status, {
            recipe,
            projectRoot,
            artifactsDir,
            env,
            outputs,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          traceWriter.record({
            nodeId: 'recipe-complete:hud',
            action: 'app.hud',
            startedAt: runHudStartedAt.toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - runHudStartedAt.getTime(),
            ok: false,
            error: message,
          });
          this.#logger.error(`app.hud complete update failed: ${message}`);
          status = 'fail';
        }
      }
      if (runRecording) {
        const recordingToStop = runRecording;
        runRecording = undefined;
        try {
          const videoArtifact = await this.#stopRunVideoRecording(recordingToStop);
          artifactWriter.register(videoArtifact);
        } catch (error) {
          const message = errorMessage(error);
          await removePartialRunVideoOutput(recordingToStop.outputPath, this.#logger);
          await rm(recordingToStop.stagingRoot, { recursive: true, force: true });
          traceWriter.record({
            nodeId: 'recipe-run:video',
            action: 'record.video',
            startedAt: startedAt.toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt.getTime(),
            ok: false,
            error: message,
          });
          this.#logger.error(`record.video failed: ${message}`);
          status = 'fail';
        }
      }
    } finally {
      if (runRecording) {
        const recordingToCleanup = runRecording;
        runRecording = undefined;
        await cleanupAbortedRunVideoRecording(recordingToCleanup, this.#logger);
      }
    }
    const endedAt = new Date();
    const tracePath = await traceWriter.write();
    const trace = traceWriter.list();
    const summary: SummaryDocument = {
      status,
      total: trace.length,
      passed: trace.filter((entry) => entry.ok).length,
      failed: trace.filter((entry) => !entry.ok).length,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      harness: {
        name: '@farmslot/recipe-harness',
        version: HARNESS_VERSION,
        runner_protocol_version: this.#actionManifest.runner_protocol_version,
        action_registry_version: this.#actionManifest.action_registry_version,
      },
      ...(this.#runnerProvenance ? { runner: this.#runnerProvenance } : {}),
      ...(libraryResolution
        ? { recipeLibraries: buildRecipeLibrarySummary(libraryResolution) }
        : {}),
    };
    const summaryPath = await summaryWriter.write(summary);
    const artifactManifestPath = await artifactWriter.write(status, this.#runnerProvenance);

    const packageValidation = validateRecipeArtifactPackage({
      recipe,
      resolvedRecipes: Object.fromEntries(
        [...dependencyResolution.recipes.values()].map((entry) => [
          entry.provenance.digest!,
          entry.document,
        ]),
      ),
      recipeResolution: dependencyResolution.document,
      manifest: {
        version: 1,
        runStatus: status,
        ...(this.#runnerProvenance ? { provenance: { runner: this.#runnerProvenance } } : {}),
        artifacts: artifactWriter.list(),
      },
      artifactPaths: [
        'recipe.json',
        'summary.json',
        'trace.json',
        'artifact-manifest.json',
        'recipe-resolution.json',
        ...artifactWriter.list().map((entry) => entry.path),
      ],
    });
    if (packageValidation.status === 'invalid') {
      throw new Error(
        `Generated artifact package is invalid: ${packageValidation.findings
          .map((finding) => `${finding.code} ${finding.path}`)
          .join(', ')}`,
      );
    }

    return { status, summaryPath, tracePath, artifactManifestPath, recipePath };
  }

  #createExecutionContext({
    nodeId,
    recipe,
    projectRoot,
    artifactsDir,
    env,
    outputs,
    getOutput,
    artifactWriter,
    runFileOffsets,
  }: {
    nodeId: string;
    recipe: unknown;
    projectRoot: string;
    artifactsDir: string;
    env: Record<string, string | undefined>;
    outputs: ReadonlyMap<string, unknown>;
    getOutput: (nodeId: string) => unknown;
    artifactWriter: JsonArtifactWriter;
    runFileOffsets: ReadonlyMap<string, number>;
  }): Parameters<ActionAdapter['execute']>[1] {
    return {
      nodeId,
      recipe,
      projectRoot,
      artifactsDir,
      env,
      outputs,
      getOutput,
      resolveProjectPath(relativePath: string) {
        return path.join(projectRoot, normalizeRelativePath(relativePath));
      },
      resolveArtifactPath(relativePath: string) {
        return path.join(artifactsDir, normalizeRelativePath(relativePath));
      },
      getRunFileOffset(relativePath: string) {
        return runFileOffsets.get(normalizeRelativePath(relativePath).split(path.sep).join('/'));
      },
      registerArtifact(entry: RecipeArtifactManifestEntry) {
        artifactWriter.register(entry);
      },
      logger: this.#logger,
    };
  }

  #videoRecorder(): VideoRecorder {
    return this.#recording?.videoRecorder ?? createCaptureHelperVideoRecorder();
  }

  async #startRunVideoRecording({
    recorder,
    videoOptions,
    recipe,
    projectRoot,
    artifactsDir,
    env,
  }: {
    recorder: VideoRecorder;
    videoOptions: RecipeVideoRecordingOptions;
    recipe: unknown;
    projectRoot: string;
    artifactsDir: string;
    env: Record<string, string | undefined>;
  }): Promise<RunVideoRecording> {
    const doctor = await recorder.doctor?.();
    if (doctor && !doctor.ok) {
      throw new Error(
        `${recorder.name} doctor ${doctor.code}: ${doctor.message}${
          doctor.suggestedFix ? ` Suggested fix: ${doctor.suggestedFix}` : ''
        }`,
      );
    }
    const node = {
      action: 'record.video',
      intent: 'Record the recipe run when motion proof is useful',
    };
    const target =
      videoOptions.target ??
      (await this.#recording?.targetProvider?.resolveRecordingTarget({
        nodeId: 'recipe-run',
        node,
        recipe,
        projectRoot,
        artifactsDir,
        env,
        scope: 'run',
      }));
    if (!target) {
      throw new Error(
        '--record-video requires a recording target. Provide a project RecordingTargetProvider or CLI target flags.',
      );
    }
    const relativePath = 'videos/recipe-run.mp4';
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-recipe-video-'));
    const stagingRelativePath = 'recipe-run.mp4';
    const outputPath = path.join(stagingRoot, stagingRelativePath);
    let recording: ActiveVideoRecording;
    try {
      recording = await recorder.start({
        outputPath,
        target,
        maxFps: videoOptions.maxFps,
        maxSize: videoOptions.maxSize,
        nodeId: 'recipe-run',
        record: 'full_run',
      });
    } catch (error) {
      await removePartialRunVideoOutput(outputPath, this.#logger);
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
    const entry: RecipeArtifactManifestEntry = {
      path: relativePath,
      type: 'video',
      mimeType: 'video/mp4',
      category: 'proof',
      label: 'Recipe run video',
      record: 'full_run',
      recorder: {
        name: recorder.name,
        ...(recorder.version ? { version: recorder.version } : {}),
        ...(recorder.platform ? { platform: recorder.platform } : {}),
        target: manifestTarget(target),
      },
      ...(videoOptions.maxFps != null ? { maxFps: videoOptions.maxFps } : {}),
    };
    return {
      recording,
      entry,
      outputPath,
      stagingRoot,
      stagingRelativePath,
      artifactsDir,
    };
  }

  async #stopRunVideoRecording(
    runRecording: RunVideoRecording,
  ): Promise<RecipeArtifactManifestEntry> {
    const result = await runRecording.recording.stop();
    await assertVideoOutputReady(runRecording.outputPath);
    await copyFileWithinRoots(
      runRecording.stagingRoot,
      runRecording.stagingRelativePath,
      runRecording.artifactsDir,
      runRecording.entry.path,
    );
    await rm(runRecording.stagingRoot, { recursive: true, force: true });
    return result.recorder
      ? {
          ...runRecording.entry,
          recorder: result.recorder,
        }
      : runRecording.entry;
  }

  #hudAction(): string | undefined {
    if (this.#hud === false || this.#hud?.enabled === false) return undefined;
    return this.#adapters.has('app.hud') ? 'app.hud' : undefined;
  }

  async #publishHudProgressOrRecord(
    traceWriter: JsonTraceWriter,
    status: 'running' | 'pass' | 'fail',
    event: {
      nodeId: string;
      action: string;
      node: Record<string, unknown>;
      recipe: unknown;
      index: number;
      total: number;
      context: Parameters<ActionAdapter['execute']>[1];
      error?: string;
    },
  ): Promise<boolean> {
    const startedAt = new Date();
    try {
      await this.#publishHudProgress(status, event);
      return true;
    } catch (error) {
      // HUD is first-class when advertised, so rendering failures fail the run.
      // They are still recorded instead of aborting artifact package writing.
      const message = error instanceof Error ? error.message : String(error);
      traceWriter.record({
        nodeId: `${event.nodeId}:hud:${status}`,
        action: 'app.hud',
        startedAt: startedAt.toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        ok: false,
        error: message,
      });
      this.#logger.error(`app.hud ${status} update failed for ${event.nodeId}: ${message}`);
      return false;
    }
  }

  async #publishHudProgress(
    status: 'running' | 'pass' | 'fail',
    event: {
      nodeId: string;
      action: string;
      node: Record<string, unknown>;
      recipe: unknown;
      index: number;
      total: number;
      context: Parameters<ActionAdapter['execute']>[1];
      error?: string;
    },
  ): Promise<void> {
    const hudAction = this.#hudAction();
    if (!hudAction || event.action === hudAction) return;
    const adapter = this.#adapters.get(hudAction);
    if (!adapter) return;
    await verifyExecutableSource(adapter, `Action ${hudAction}`);
    await adapter.execute(buildHudNode(status, event, this.#hud), event.context);
  }

  async #publishRunHud(
    status: RecipeRunStatus,
    request: {
      recipe: unknown;
      projectRoot: string;
      artifactsDir: string;
      env: Record<string, string | undefined>;
      outputs: ReadonlyMap<string, unknown>;
    },
  ): Promise<void> {
    const hudAction = this.#hudAction();
    if (!hudAction) return;
    const adapter = this.#adapters.get(hudAction);
    if (!adapter) return;
    await verifyExecutableSource(adapter, `Action ${hudAction}`);
    const context = {
      nodeId: 'recipe-complete',
      recipe: request.recipe,
      projectRoot: request.projectRoot,
      artifactsDir: request.artifactsDir,
      env: request.env,
      outputs: request.outputs,
      getOutput(nodeId: string) {
        if (!request.outputs.has(nodeId)) throw new Error(`No output recorded for node ${nodeId}.`);
        return request.outputs.get(nodeId);
      },
      resolveProjectPath(relativePath: string) {
        return path.join(request.projectRoot, normalizeRelativePath(relativePath));
      },
      resolveArtifactPath(relativePath: string) {
        return path.join(request.artifactsDir, normalizeRelativePath(relativePath));
      },
      getRunFileOffset() {
        return undefined;
      },
      registerArtifact() {},
      logger: this.#logger,
    };
    await adapter.execute(
      {
        action: hudAction,
        title: this.#hudTitle(request.recipe),
        status,
        node_id: 'recipe-complete',
        phase: 'complete',
        flow: 'run',
        detail: status === 'pass' ? 'Recipe completed' : 'Recipe failed',
        text: status === 'pass' ? 'Recipe completed' : 'Recipe failed',
        progress: { complete: true },
      },
      context,
    );
  }

  #hudTitle(recipe: unknown): string {
    if (this.#hud && this.#hud.title) return this.#hud.title;
    if (isRecord(recipe) && typeof recipe.title === 'string') return recipe.title;
    return 'Recipe run';
  }
}

interface RunVideoRecording {
  recording: ActiveVideoRecording;
  entry: RecipeArtifactManifestEntry;
  outputPath: string;
  stagingRoot: string;
  stagingRelativePath: string;
  artifactsDir: string;
}

function buildRecipeLibrarySummary(resolution: RecipeLibraryResolution): RecipeLibrarySummary {
  return {
    sources: resolution.sources,
    shadowed: collectShadowedRecipes(resolution),
  };
}

function collectShadowedRecipes(
  resolution: RecipeLibraryResolution,
): RecipeLibrarySummary['shadowed'] {
  return [...resolution.recipes.values()]
    .filter((recipe) => recipe.shadows.length > 0)
    .map((recipe) => ({
      ref: recipe.ref,
      source: recipe.source,
      file: recipe.file,
      shadows: recipe.shadows,
    }));
}

function rootRecipeRef(
  sourceRecipePath: string | undefined,
  recipes: ReadonlyMap<string, ResolvedLibraryRecipe>,
  digest: string,
): string {
  if (sourceRecipePath) {
    const resolvedPath = path.resolve(sourceRecipePath);
    const match = [...recipes.values()].find(
      (recipe) => path.resolve(recipe.path) === resolvedPath,
    );
    if (match) return match.ref;
    return rootResolutionRef(digest);
  }
  return rootResolutionRef(digest);
}

function normalizeVideoRecordingOptions(
  input: RecipeRunRequest['recordVideo'],
): RecipeVideoRecordingOptions & { mode: 'off' | 'full-run' } {
  if (!input) return { mode: 'off' };
  if (input === true) return { mode: 'full-run' };
  if (typeof input === 'string') return normalizeVideoRecordingMode(input);
  const mode = input.mode ?? 'full-run';
  return { ...input, mode: normalizeVideoRecordingMode(mode).mode };
}

function normalizeVideoRecordingMode(mode: unknown): { mode: 'off' | 'full-run' } {
  if (mode === 'off') return { mode: 'off' };
  if (mode === 'full-run') return { mode: 'full-run' };
  if (mode === 'proof-window' || mode === 'proof_window') {
    throw new Error(
      'recordVideo proof-window mode is reserved for future focused clips; use full-run for phase 1.',
    );
  }
  throw new Error(`recordVideo mode must be full-run or off, got ${JSON.stringify(mode)}.`);
}

async function assertVideoOutputReady(outputPath: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(outputPath);
  } catch {
    throw new Error(`Recording output is missing: ${outputPath}`);
  }
  if (stats.size <= 0) throw new Error(`Recording output is empty: ${outputPath}`);
}
