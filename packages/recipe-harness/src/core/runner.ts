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

import { buildResolvedRecipe } from './compose.js';
import { collectFlows, executeInlineFlowCall, type InlineFlow } from './flows.js';
import {
  extractWorkflowGraph,
  normalizePreconditionResult,
  resolveNextNode,
  type WorkflowGraph,
} from './graph.js';
import { buildHudNode } from './hud.js';
import { isRecord, normalizeRelativePath, readJsonFile } from './json.js';
import {
  createEffectiveFlowCatalog,
  loadRecipeLibraries,
  type RecipeLibraryResolution,
  type ResolvedLibraryFlow,
} from './library.js';
import {
  declaredObserverRefsFromManifest,
  defaultObserverRefsFromManifest,
  finalizeNodeObservations,
  resolveObserveRefs,
  runPassiveObservers,
} from './passive-observations.js';
import { copyFileWithinRoots, statFileWithinRoot, writeFileWithinRoot } from './path.js';
import { evaluateNodeGate } from './predicates.js';
import {
  cleanupAbortedRunVideoRecording,
  removePartialRunVideoOutput,
} from './recording-cleanup.js';
import { recordSyntheticFailure, traceNodeMetadata } from './trace.js';
import {
  buildRecipeExecutionPlan,
  enforceRecipeExecutionPlan,
  recipeSourceForRequest,
  verifyExecutableSource,
} from './trust.js';
import type {
  ActionAdapter,
  ActiveVideoRecording,
  CreateRecipeRunnerOptions,
  PreconditionChecker,
  RecipeFlowResolutionSummary,
  RecipeHudOptions,
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
const RUNNER_BUILT_IN_ACTIONS = new Set(['call']);
const DEFAULT_MAX_FLOW_CALL_DEPTH = 8;
const noopLogger: RecipeLogger = {
  info() {},
  warn() {},
  error() {},
};

interface ResolvedRecipeRun {
  projectRoot: string;
  artifactsDir: string;
  sourceRecipePath?: string;
  recipe: unknown;
  recipeSource: ReturnType<typeof recipeSourceForRequest>;
  libraryResolution?: RecipeLibraryResolution;
  graph: WorkflowGraph;
  usedLibraryFlows: Map<string, ResolvedLibraryFlow>;
  flowCatalog: ReadonlyMap<string, InlineFlow>;
  flowOverrides: RecipeFlowResolutionSummary['overrides'];
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
  const preconditionMap = new Map<string, PreconditionChecker>();
  const declaredPreconditions = new Set(
    (options.actionManifest.pre_conditions ?? []).map((entry) => entry.id),
  );

  for (const checker of options.preconditions ?? []) {
    if (!checker.id.trim()) throw new Error('Precondition checker id must be a non-empty string.');
    if (!declaredPreconditions.has(checker.id)) {
      throw new Error(`Precondition checker ${checker.id} is not declared by the action manifest.`);
    }
    if (preconditionMap.has(checker.id)) {
      throw new Error(`Precondition checker ${checker.id} is registered more than once.`);
    }
    preconditionMap.set(checker.id, checker);
  }

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
    preconditionMap,
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
  flows,
  projectRoot,
}: {
  graph: WorkflowGraph;
  flows: ReadonlyMap<string, InlineFlow>;
  projectRoot: string;
}): Promise<Map<string, number>> {
  const offsets = new Map<string, number>();
  const paths = new Set<string>();
  collectWatchLogPaths(paths, graph.nodes);
  for (const flow of flows.values()) collectWatchLogPaths(paths, flow.nodes);
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
  readonly #preconditions: ReadonlyMap<string, PreconditionChecker>;
  readonly #logger: RecipeLogger;
  readonly #defaultObserverRefs;
  readonly #declaredObserverRefs;
  readonly #hud: RecipeHudOptions | false | undefined;
  readonly #runnerProvenance: CreateRecipeRunnerOptions['runner'];
  readonly #recording: RecipeRecordingOptions | undefined;
  readonly #defaultSource: CreateRecipeRunnerOptions['defaultSource'];
  readonly #blockedCapabilities: CreateRecipeRunnerOptions['blockedCapabilities'];

  constructor(
    actionManifest: RecipeActionManifestDocument,
    adapters: ReadonlyMap<string, ActionAdapter>,
    preconditions: ReadonlyMap<string, PreconditionChecker>,
    logger: RecipeLogger,
    hud: RecipeHudOptions | false | undefined,
    runnerProvenance: CreateRecipeRunnerOptions['runner'],
    recording: RecipeRecordingOptions | undefined,
    defaultSource: CreateRecipeRunnerOptions['defaultSource'],
    blockedCapabilities: CreateRecipeRunnerOptions['blockedCapabilities'],
  ) {
    this.#actionManifest = actionManifest;
    this.#adapters = adapters;
    this.#preconditions = preconditions;
    this.#logger = logger;
    this.#defaultObserverRefs = defaultObserverRefsFromManifest(actionManifest);
    this.#declaredObserverRefs = declaredObserverRefsFromManifest(actionManifest);
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
    const sourceRecipePath = request.recipePath ? path.resolve(request.recipePath) : undefined;
    const recipe = request.recipeDocument ?? (await readJsonFile(sourceRecipePath!));
    const recipeSource = recipeSourceForRequest(
      request,
      recipe,
      sourceRecipePath,
      this.#defaultSource,
    );
    const libraryResolution: RecipeLibraryResolution | undefined =
      request.librarySources && request.librarySources.length > 0
        ? await loadRecipeLibraries(request.librarySources, this.#logger)
        : undefined;
    assertRecipeMatchesManifest(
      recipe,
      this.#actionManifest,
      libraryResolution ? { externalFlowIds: new Set(libraryResolution.flows.keys()) } : undefined,
    );
    const graph = extractWorkflowGraph(recipe);
    const recipeLocalFlows = await collectFlows(recipe, {
      projectRoot,
      recipeDir: sourceRecipePath ? path.dirname(sourceRecipePath) : projectRoot,
      recipeSource,
    });
    const usedLibraryFlows = new Map<string, ResolvedLibraryFlow>();
    const { catalog: flowCatalog, overrides: flowOverrides } = createEffectiveFlowCatalog(
      recipeLocalFlows,
      libraryResolution,
      usedLibraryFlows,
      this.#logger,
    );
    const executionPlan = buildRecipeExecutionPlan({
      recipe,
      source: recipeSource,
      graph,
      flows: flowCatalog,
      adapters: this.#adapters,
      preconditions: this.#preconditions,
      actionManifest: this.#actionManifest,
      hud: this.#hud,
      recordVideo: request.recordVideo,
    });
    return {
      projectRoot,
      artifactsDir,
      sourceRecipePath,
      recipe,
      recipeSource,
      libraryResolution,
      graph,
      usedLibraryFlows,
      flowCatalog,
      flowOverrides,
      executionPlan,
    };
  }

  async run(request: RecipeRunRequest): Promise<RecipeRunResult> {
    const {
      projectRoot,
      artifactsDir,
      recipe,
      libraryResolution,
      graph,
      usedLibraryFlows,
      flowCatalog,
      flowOverrides,
      executionPlan,
    } = await this.#resolveRequest(request);
    enforceRecipeExecutionPlan(executionPlan, request, this.#blockedCapabilities);
    const startedAt = new Date();
    await mkdir(artifactsDir, { recursive: true });
    const runFileOffsets = await collectRunFileOffsets({
      graph,
      flows: flowCatalog,
      projectRoot,
    });

    const artifactWriter = new JsonArtifactWriter(artifactsDir);
    const traceWriter = new JsonTraceWriter(artifactsDir, this.#runnerProvenance);
    const summaryWriter = new JsonSummaryWriter(artifactsDir);
    const outputs = new Map<string, unknown>();
    const recipePath = await artifactWriter.copyRecipe(recipe);
    // Emit the fully-composed recipe when `uses`/library composition adds flows the
    // authored recipe.json does not already inline. buildResolvedRecipe inlines only
    // the reachable flows (never the whole library) and drops `uses`, so the result
    // is self-contained; it returns the same reference when there is nothing to add.
    const resolvedRecipe = buildResolvedRecipe(recipe, flowCatalog);
    if (resolvedRecipe !== recipe) {
      await artifactWriter.writeResolvedRecipe(resolvedRecipe);
    }
    let status: RecipeRunStatus = 'unknown';
    let currentNodeId: string | undefined = graph.entry;
    let mainStatus: RecipeRunStatus = 'unknown';
    let runningTeardown = false;
    const visited = new Set<string>();
    let transitionCount = 0;
    const maxTransitions = Object.keys(graph.nodes).length * 3;
    const videoOptions = normalizeVideoRecordingOptions(request.recordVideo);
    const videoRecorder = videoOptions.mode !== 'off' ? this.#videoRecorder() : undefined;
    let runRecording: RunVideoRecording | undefined;
    if (videoRecorder) {
      try {
        runRecording = await this.#startRunVideoRecording({
          recorder: videoRecorder,
          videoOptions,
          recipe,
          projectRoot,
          artifactsDir,
          env: request.env ?? {},
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
        currentNodeId = undefined;
      }
    }

    try {
      if (currentNodeId) {
        const preconditionStatus = await this.#runPreconditions({
          graph,
          recipe,
          projectRoot,
          artifactsDir,
          request,
          outputs,
          artifactWriter,
          traceWriter,
          runFileOffsets,
        });
        if (preconditionStatus === 'fail') {
          status = 'fail';
          currentNodeId = undefined;
        }
      }

      while (currentNodeId) {
        const activeNodeId = currentNodeId;
        transitionCount += 1;
        if (transitionCount > maxTransitions) {
          const error = new Error('Recipe graph exceeded its maximum transition count.');
          recordSyntheticFailure(traceWriter, activeNodeId, error);
          status = 'fail';
          break;
        }
        visited.add(activeNodeId);
        const node = graph.nodes[activeNodeId];
        if (!node) {
          const error = new Error(`Recipe node ${activeNodeId} does not exist.`);
          recordSyntheticFailure(traceWriter, activeNodeId, error);
          status = 'fail';
          break;
        }
        const action = String(node.action);
        const adapter = action === 'call' ? undefined : this.#adapters.get(action);
        if (action !== 'call' && !adapter) {
          const error = new Error(`No adapter registered for action ${action}.`);
          recordSyntheticFailure(traceWriter, activeNodeId, error, action);
          status = 'fail';
          break;
        }

        const nodeStartedAt = new Date();
        const context = this.#createExecutionContext({
          nodeId: activeNodeId,
          recipe,
          projectRoot,
          artifactsDir,
          env: request.env ?? {},
          outputs,
          artifactWriter,
          runFileOffsets,
        });
        try {
          const gate = evaluateNodeGate(node, context.outputs);
          if (!gate.run) {
            const next = resolveNextNode(node, {});
            traceWriter.record({
              nodeId: activeNodeId,
              action,
              ...traceNodeMetadata(node),
              startedAt: nodeStartedAt.toISOString(),
              endedAt: new Date().toISOString(),
              durationMs: Date.now() - nodeStartedAt.getTime(),
              ok: true,
              next,
              output: { skipped: true, reason: gate.reason },
            });
            currentNodeId = next;
            continue;
          }
          const hudStarted = await this.#publishHudProgressOrRecord(traceWriter, 'running', {
            nodeId: activeNodeId,
            action,
            node,
            recipe,
            index: transitionCount,
            total: Object.keys(graph.nodes).length,
            context,
          });
          if (!hudStarted) {
            status = 'fail';
            break;
          }
          let result;
          if (action === 'call') {
            result = await executeInlineFlowCall({
              callNodeId: activeNodeId,
              node,
              context,
              flowCatalog,
              adapters: this.#adapters,
              traceWriter,
              callStack: [],
              maxCallDepth: DEFAULT_MAX_FLOW_CALL_DEPTH,
              logger: this.#logger,
              defaultObserverRefs: this.#defaultObserverRefs,
              declaredObserverRefs: this.#declaredObserverRefs,
              publishHudProgress: (hudStatus, flowEvent) =>
                this.#publishHudProgressOrRecord(traceWriter, hudStatus, {
                  ...flowEvent,
                  recipe,
                }),
            });
          } else {
            await verifyExecutableSource(adapter!, `Action ${action}`);
            result = await adapter!.execute(node, context);
          }
          const observeRefs = resolveObserveRefs(
            action,
            node,
            this.#defaultObserverRefs,
            this.#declaredObserverRefs,
          );
          const observationResult =
            action !== 'call' && (result.status == null || result.status === 'pass')
              ? await runPassiveObservers({
                  action,
                  node,
                  adapter: adapter!,
                  context,
                  logger: this.#logger,
                  refs: observeRefs,
                })
              : {};
          if (result.output !== undefined) outputs.set(activeNodeId, result.output);
          for (const artifact of result.artifacts ?? []) artifactWriter.register(artifact);
          const next = resolveNextNode(node, result);
          const { observations, observationWarnings } = finalizeNodeObservations({
            nodeId: activeNodeId,
            node,
            result,
            observationResult,
            observeRefs,
          });
          traceWriter.record({
            nodeId: activeNodeId,
            action,
            ...traceNodeMetadata(node, result),
            startedAt: nodeStartedAt.toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - nodeStartedAt.getTime(),
            ok: true,
            next,
            status: result.status,
            case: result.case,
            output: result.output,
            ...(observations ? { observations } : {}),
            ...(observationWarnings.length ? { observationWarnings } : {}),
          });
          const hudCompleted = await this.#publishHudProgressOrRecord(
            traceWriter,
            result.status === 'fail' ? 'fail' : 'pass',
            {
              nodeId: activeNodeId,
              action,
              node,
              recipe,
              index: transitionCount,
              total: Object.keys(graph.nodes).length,
              context,
            },
          );
          if (!hudCompleted) {
            status = 'fail';
            break;
          }
          if (result.status) {
            if (runningTeardown) {
              status = mainStatus === 'fail' ? 'fail' : result.status;
              break;
            }
            mainStatus = result.status;
            if (graph.teardownEntry) {
              runningTeardown = true;
              currentNodeId = graph.teardownEntry;
              continue;
            }
            status = result.status;
            break;
          }
          currentNodeId = next;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          traceWriter.record({
            nodeId: activeNodeId,
            action,
            ...traceNodeMetadata(node),
            startedAt: nodeStartedAt.toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - nodeStartedAt.getTime(),
            ok: false,
            error: message,
          });
          this.#logger.error(message);
          await this.#publishHudProgressOrRecord(traceWriter, 'fail', {
            nodeId: activeNodeId,
            action,
            node,
            recipe,
            index: transitionCount,
            total: Object.keys(graph.nodes).length,
            context,
            error: message,
          });
          status = 'fail';
          if (!runningTeardown && graph.teardownEntry) {
            mainStatus = 'fail';
            runningTeardown = true;
            currentNodeId = graph.teardownEntry;
            continue;
          }
          break;
        }
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
      // Any resolution activity — a library flow used, a recipe-local override,
      // or cross-source shadowing — gets the artifact, so an all-overridden run
      // still leaves reviewable evidence of what the library would have provided.
      const shadowedFlows = libraryResolution ? collectShadowedFlows(libraryResolution) : [];
      if (
        libraryResolution &&
        (usedLibraryFlows.size > 0 || flowOverrides.length > 0 || shadowedFlows.length > 0)
      ) {
        await writeFileWithinRoot(
          artifactsDir,
          'resolved-flows.json',
          `${JSON.stringify(
            {
              schema_version: 1,
              kind: 'recipe-resolved-flows',
              sources: libraryResolution.sources,
              overrides: flowOverrides,
              shadowed: shadowedFlows,
              flows: Object.fromEntries(
                [...usedLibraryFlows.values()].map((flow) => [
                  flow.ref,
                  { source: flow.source, file: flow.file, definition: flow.raw },
                ]),
              ),
            },
            null,
            2,
          )}\n`,
        );
        artifactWriter.register({
          path: 'resolved-flows.json',
          type: 'json',
          label: 'Library flow resolution for this run',
          category: 'system',
        });
      }
      if (status === 'pass') {
        const runHudStartedAt = new Date();
        try {
          await this.#publishRunHud(status, {
            recipe,
            projectRoot,
            artifactsDir,
            env: request.env ?? {},
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
        ? {
            flowResolution: buildFlowResolutionSummary(
              libraryResolution,
              usedLibraryFlows,
              flowOverrides,
            ),
          }
        : {}),
    };
    const summaryPath = await summaryWriter.write(summary);
    const artifactManifestPath = await artifactWriter.write(status, this.#runnerProvenance);

    const packageValidation = validateRecipeArtifactPackage({
      recipe,
      // Hand the composed recipe and the run outcome to the validator: it validates
      // the composition in full only for a passing run (parity with gateway/CLI), and
      // leaves a gracefully-failed run's composition unchecked.
      ...(resolvedRecipe !== recipe ? { resolvedRecipe } : {}),
      // Only a confirmed failure relaxes composition enforcement; an unknown/incomplete
      // status still requires the composition to be proven.
      runPassed: status !== 'fail',
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

  async #runPreconditions({
    graph,
    recipe,
    projectRoot,
    artifactsDir,
    request,
    outputs,
    artifactWriter,
    traceWriter,
    runFileOffsets,
  }: {
    graph: WorkflowGraph;
    recipe: unknown;
    projectRoot: string;
    artifactsDir: string;
    request: RecipeRunRequest;
    outputs: Map<string, unknown>;
    artifactWriter: JsonArtifactWriter;
    traceWriter: JsonTraceWriter;
    runFileOffsets: ReadonlyMap<string, number>;
  }): Promise<'pass' | 'fail'> {
    for (const gate of graph.preconditions) {
      const nodeId = `pre_conditions:${gate.id}`;
      const checker = this.#preconditions.get(gate.id);
      if (!checker) {
        recordSyntheticFailure(
          traceWriter,
          nodeId,
          new Error(
            `Precondition ${gate.id} is declared by the recipe but has no checker registered.`,
          ),
          'pre_condition',
        );
        return 'fail';
      }
      const startedAt = new Date();
      const context = this.#createExecutionContext({
        nodeId,
        recipe,
        projectRoot,
        artifactsDir,
        env: request.env ?? {},
        outputs,
        artifactWriter,
        runFileOffsets,
      });
      try {
        await verifyExecutableSource(checker, `Precondition ${gate.id}`);
        const rawResult = await checker.execute(gate, context);
        const result = normalizePreconditionResult(rawResult);
        if (result.output !== undefined) outputs.set(nodeId, result.output);
        if (result.ok === false) {
          throw new Error(result.error ?? `Precondition ${gate.id} failed.`);
        }
        traceWriter.record({
          nodeId,
          action: 'pre_condition',
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          ok: true,
          output: result.output,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        traceWriter.record({
          nodeId,
          action: 'pre_condition',
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          ok: false,
          error: message,
        });
        return 'fail';
      }
    }
    return 'pass';
  }

  #createExecutionContext({
    nodeId,
    recipe,
    projectRoot,
    artifactsDir,
    env,
    outputs,
    artifactWriter,
    runFileOffsets,
  }: {
    nodeId: string;
    recipe: unknown;
    projectRoot: string;
    artifactsDir: string;
    env: Record<string, string | undefined>;
    outputs: Map<string, unknown>;
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
      getOutput(nodeId: string) {
        if (!outputs.has(nodeId)) throw new Error(`No output recorded for node ${nodeId}.`);
        return outputs.get(nodeId);
      },
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

function buildFlowResolutionSummary(
  resolution: RecipeLibraryResolution,
  usedLibraryFlows: ReadonlyMap<string, ResolvedLibraryFlow>,
  overrides: RecipeFlowResolutionSummary['overrides'],
): RecipeFlowResolutionSummary {
  return {
    sources: resolution.sources,
    used: [...usedLibraryFlows.values()].map((flow) => ({
      ref: flow.ref,
      source: flow.source,
      file: flow.file,
      ...(flow.shadows.length > 0 ? { shadows: flow.shadows } : {}),
      ...(flow.lastVerified ? { lastVerified: flow.lastVerified } : {}),
    })),
    overrides,
    shadowed: collectShadowedFlows(resolution),
  };
}

function collectShadowedFlows(
  resolution: RecipeLibraryResolution,
): RecipeFlowResolutionSummary['shadowed'] {
  return [...resolution.flows.values()]
    .filter((flow) => flow.shadows.length > 0)
    .map((flow) => ({
      ref: flow.ref,
      source: flow.source,
      file: flow.file,
      shadows: flow.shadows,
    }));
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
