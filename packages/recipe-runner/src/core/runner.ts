import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_RECORDED_EVIDENCE_POLICY,
  digestRecipeDocument,
  getRecipeActionManifestActionNames,
  hasUnresolvedRecipeFailure,
  type RecipeActionManifestDocument,
  type RecipeArtifactManifestEntry,
  type RecipeClaimLedger,
  type RecipeExecutionPlan,
  type RecipeRecordingTimelineDocument,
  type RecipeVideoTiming,
  type RecordingSegmentRef,
  validateRecipeRecordingTarget,
} from '@farmslot/protocol';

import { proofDocument } from '../evidence/assertions.js';
import { deriveRecipeClaims } from '../evidence/claims.js';
import { occurrenceRecordingCoverage } from '../evidence/moments.js';
import { validateRecordedEvidencePackage } from '../evidence/package.js';
import { planRecipeEvidence, type RecipeEvidencePlan } from '../evidence/plan.js';
import { materializeEvidenceStill } from '../evidence/stills.js';
import {
  JsonArtifactWriter,
  JsonSummaryWriter,
  JsonTraceWriter,
  summarizeTraceCounts,
} from '../node/writers.js';
import {
  createCaptureHelperVideoRecorder,
  errorMessage,
  manifestTarget,
} from '../recording/capture-helper.js';
import {
  CAPTURE_INTERRUPTED,
  captureInterruptedTraceEntry,
  runCaptureInterruption,
} from '../recording/capture-helper-interruption.js';
import { writeRecordingTimeline } from '../recording/timeline.js';
import { RECIPE_RUNNER_VERSION } from '../version.js';

import {
  type ResolvedRecipeDependencies,
  resolveRecipeDependencies,
  rootResolutionRef,
  validateRecipeDependencyParams,
} from './compose.js';
import { executeRecipe } from './execution.js';
import {
  RecipeExecutionError,
  recipeFailureCause,
  recipeFailureTraceFields,
  RUNTIME_CONNECTION_CLOSED,
} from './failure.js';
import { extractWorkflowGraph, type WorkflowGraph } from './graph.js';
import { buildHudNode } from './hud.js';
import { createRecipeInvocation } from './invocation.js';
import { isRecord, normalizeRelativePath, readJsonFile } from './json.js';
import {
  loadRecipeLibraries,
  logRecipeLibraryShadows,
  logRecipeLibrarySources,
  type RecipeLibraryResolution,
  type ResolvedLibraryRecipe,
} from './library.js';
import { resolveRecipeParams } from './parameters.js';
import { defaultObserverRefsFromManifest } from './passive-observations.js';
import {
  copyFileWithinRoots,
  digestFileWithinRoot,
  statFileWithinRoot,
  writeFileWithinRoot,
} from './path.js';
import {
  cleanupAbortedRunVideoRecording,
  removePartialRunVideoOutput,
} from './recording-cleanup.js';
import { boundRecording } from './recording-limits.js';
import { startSegmentedRecording } from './recording-segments.js';
import { RecipeResolutionError } from './resolution-error.js';
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
  RecipeRunCaptureInterruption,
  RecipeRunner,
  RecipeRunRequest,
  RecipeRunResult,
  RecipeRunStatus,
  RecipeVideoRecordingOptions,
  RecordingAdmissionLease,
  SummaryDocument,
  TraceEntry,
  VideoRecorder,
} from './types.js';
import { assertManifestIsValid, assertRecipeMatchesManifest } from './validation.js';

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
  evidencePlan: RecipeEvidencePlan;
  recordingRequired: boolean;
  videoOptions: RecipeVideoRecordingOptions & { mode: 'off' | 'full-run' };
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
    if (recipe.aliasFor) continue;
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
            ...(request.packageVersions ? { packageVersions: request.packageVersions } : {}),
          })
        : undefined;
    if (libraryResolution) logRecipeLibrarySources(this.#logger, libraryResolution);
    const recipes = libraryResolution?.recipes ?? new Map<string, ResolvedLibraryRecipe>();
    const externalRecipeIds = new Set(recipes.keys());
    assertRecipeMatchesManifest(recipe, this.#actionManifest, {
      externalRecipeIds,
      adapter: request.adapter,
    });
    const graph = extractWorkflowGraph(recipe);
    if (request.stopAfterNode !== undefined) {
      const stoppable = [...graph.mainNodeIds].filter(
        (nodeId) => graph.nodes[nodeId]?.action !== 'end',
      );
      if (!stoppable.includes(request.stopAfterNode)) {
        throw new RecipeResolutionError(
          'RECIPE_STOP_AFTER_NODE_INVALID',
          `stop-after-node ${request.stopAfterNode} is not a non-terminal node reachable from workflow.entry.`,
          `choose one of: ${stoppable.join(', ')}`,
        );
      }
    }
    const rootRef = rootRecipeRef(sourceRecipePath, recipes, recipeSource.digest!);
    const dependencyResolution = resolveRecipeDependencies({
      rootRef,
      root: recipe,
      rootSource: recipeSource,
      recipes,
    });
    if (libraryResolution) {
      // Warn only about shadowed refs this run executes, not every winner in the libraries.
      logRecipeLibraryShadows(
        this.#logger,
        libraryResolution,
        new Set([rootRef, ...dependencyResolution.recipes.keys()]),
      );
    }
    if (request.selection) {
      const { name, resolvedBy, source, file } = request.selection;
      this.#logger.info(`Recipe ${name} selected by ${resolvedBy}: ${source} · ${file}`);
    }
    for (const resolved of dependencyResolution.recipes.values()) {
      assertRecipeMatchesManifest(resolved.document, this.#actionManifest, {
        externalRecipeIds,
        adapter: request.adapter,
      });
    }
    const params = resolveRecipeParams(rootRef, recipe, request.params ?? {});
    validateRecipeDependencyParams({
      root: recipe,
      params,
      recipes: dependencyResolution.recipes,
    });
    const evidencePlan = planRecipeEvidence(
      proofDocument(recipe),
      new Map(
        [...dependencyResolution.recipes].map(([ref, entry]) => [
          ref,
          proofDocument(entry.document),
        ]),
      ),
      request.claims,
    );
    const needsUi = [...evidencePlan.nodes.values()].some((node) => node.action.startsWith('ui.'));
    const videoOptions = normalizeVideoRecordingOptions(
      request.recordVideo,
      needsUi,
      request.recordingReason,
    );
    const executionPlan = buildRecipeExecutionPlan({
      recipe,
      params,
      source: recipeSource,
      recipes: dependencyResolution.recipes,
      adapters: this.#adapters,
      actionManifest: this.#actionManifest,
      defaultObserverRefs: this.#defaultObserverRefs,
      projectRoot,
      artifactsDir,
      env,
      hud: this.#hud,
      recordVideo: videoOptions.mode === 'off' ? false : videoOptions,
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
      evidencePlan,
      recordingRequired: needsUi,
      videoOptions,
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
      evidencePlan,
      recordingRequired,
      videoOptions,
    } = await this.#resolveRequest(request);
    enforceRecipeExecutionPlan(executionPlan, request, this.#blockedCapabilities);
    const startedAt = new Date();
    const recipeRunId = randomUUID();
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
    const invocation = createRecipeInvocation(
      recipe,
      params,
      startedAt.toISOString(),
      request.claims,
      recipeRunId,
    );
    await artifactWriter.writeInvocation(invocation);
    for (const dependency of dependencyResolution.recipes.values()) {
      await artifactWriter.copyResolvedRecipe(dependency.provenance.digest!, dependency.document);
    }
    await artifactWriter.writeRecipeResolution(dependencyResolution.document);
    let status: RecipeRunStatus = 'unknown';
    const segments: RecordingSegmentRef[] = [];
    const timelines = new Map<string, RecipeRecordingTimelineDocument>();
    const videoRecorder = videoOptions.mode !== 'off' ? this.#videoRecorder() : undefined;
    let runRecording: RunVideoRecording | undefined;
    let captureInterruption: RecipeRunCaptureInterruption | undefined;
    let completionHudFailure: TraceEntry | undefined;
    const videoTimelines: { entry: RecipeArtifactManifestEntry; timing: RecipeVideoTiming }[] = [];
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
        const causeClass = recipeFailureCause(error, 'harness');
        traceWriter.record({
          nodeId: 'recipe-run:video',
          action: 'record.video',
          startedAt: startedAt.toISOString(),
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          ok: false,
          cause_class: causeClass,
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
          signal: request.signal,
          ref: rootRef,
          adapter: request.adapter,
          recipe,
          params,
          recipes,
          actionManifest: this.#actionManifest,
          adapters: this.#adapters,
          traceWriter,
          claimProjections: evidencePlan.nodes,
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
              recording: runRecording,
            }),
          registerArtifacts: (artifacts) => {
            for (const artifact of artifacts) artifactWriter.register(artifact);
          },
          publishHudProgress: (hudStatus, event) =>
            this.#publishHudProgressOrRecord(traceWriter, hudStatus, event),
          ...(request.stopAfterNode !== undefined ? { stopAfterNode: request.stopAfterNode } : {}),
        });
        status = hasUnresolvedRecipeFailure(traceWriter.list()) ? 'fail' : execution.status;
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
      if (status === 'pass' || status === 'fail') {
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
          const fields = recipeFailureTraceFields(error);
          const captureEndpointLost =
            captureInterruption && fields.error_code === RUNTIME_CONNECTION_CLOSED;
          completionHudFailure = {
            nodeId: 'recipe-complete:hud',
            action: 'app.hud',
            startedAt: runHudStartedAt.toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - runHudStartedAt.getTime(),
            ok: false,
            cause_class: captureEndpointLost ? 'environment' : recipeFailureCause(error, 'harness'),
            error: message,
            ...fields,
            ...(captureEndpointLost
              ? {
                  error_code: CAPTURE_INTERRUPTED,
                  error_details: { runtime_error_code: fields.error_code },
                }
              : {}),
          };
          traceWriter.record(completionHudFailure);
          this.#logger.error(`app.hud complete update failed: ${message}`);
          status = 'fail';
        }
      }
      if (runRecording) {
        const recordingToStop = runRecording;
        runRecording = undefined;
        try {
          const { videos, interruption, releaseFailure } = await this.#stopRunVideoRecording(
            recordingToStop,
            traceWriter,
            artifactWriter,
            startedAt,
          );
          for (const video of videos)
            if (video.timing) videoTimelines.push({ entry: video.entry, timing: video.timing });
          if (releaseFailure) {
            this.#logger.error(`Recording lease cleanup failed: ${releaseFailure}`);
            status = 'fail';
          }
          if (interruption) {
            // The partial video stays registered as evidence; the run still fails, typed.
            captureInterruption = interruption;
            if (completionHudFailure?.error_code === RUNTIME_CONNECTION_CLOSED) {
              completionHudFailure.error_code = CAPTURE_INTERRUPTED;
              completionHudFailure.cause_class = 'environment';
              completionHudFailure.error_details = {
                runtime_error_code: RUNTIME_CONNECTION_CLOSED,
              };
            }
            this.#logger.error(`record.video interrupted: ${interruption.message}`);
            status = 'fail';
          }
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
            cause_class: recipeFailureCause(error, 'harness'),
            error: message,
          });
          this.#logger.error(`record.video failed: ${message}`);
          status = 'fail';
        }
      }
      for (const entry of artifactWriter
        .list()
        .filter((artifact) => artifact.type === 'video' && artifact.sha256)) {
        for (const still of artifactWriter.list()) {
          const source = still.metadata?.recordedEvidence;
          if (isRecord(source) && source.videoPath === entry.path)
            source.videoDigest = `sha256:${entry.sha256}`;
        }
      }
      for (const { entry, timing } of videoTimelines) {
        try {
          entry.timelinePath = await writeRecordingTimeline(
            artifactsDir,
            entry.path,
            timing,
            traceWriter.list(),
          );
          artifactWriter.register(entry);
          artifactWriter.register({
            path: entry.timelinePath,
            type: 'json',
            category: 'system',
            label: 'Recording frames and action markers',
          });
        } catch (error) {
          // Valid footage is retained when its optional trace alignment is unavailable.
          entry.timelineUnavailableReason = errorMessage(error);
          artifactWriter.register(entry);
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
    for (const artifact of artifactWriter.list()) {
      if (artifact.type !== 'video') continue;
      const videoDigest = artifact.sha256
        ? `sha256:${artifact.sha256}`
        : await digestFileWithinRoot(artifactsDir, artifact.path);
      segments.push({
        videoPath: artifact.path,
        videoDigest,
        ...(artifact.timelinePath ? { timelinePath: artifact.timelinePath } : {}),
        ...(artifact.metadata?.gapBefore === true ? { gapBefore: true } : {}),
      });
      if (artifact.timelinePath)
        timelines.set(
          artifact.path,
          (await readJsonFile(
            path.join(artifactsDir, artifact.timelinePath),
          )) as RecipeRecordingTimelineDocument,
        );
    }
    const pendingClaims = deriveRecipeClaims({
      recipeRunId,
      ...evidencePlan,
      trace,
      artifacts: artifactWriter.list(),
      segments,
      timelines,
    });
    const derivativeIssues: { nodeId?: string; error: string }[] = [];
    const requiredStills = [...new Set(pendingClaims.flatMap((claim) => claim.assertionIndices))];
    await mkdir(path.join(artifactsDir, 'stills'), { recursive: true });
    for (const traceIndex of requiredStills) {
      const nodeId = trace[traceIndex]?.nodeId;
      if (
        !trace[traceIndex]?.action.startsWith('ui.') ||
        artifactWriter
          .list()
          .some(
            (artifact) =>
              artifact.type === 'screenshot' &&
              artifact.nodeId === nodeId &&
              isRecord(artifact.metadata?.recordedEvidence),
          )
      )
        continue;
      const segment = occurrenceRecordingCoverage(traceIndex, segments, timelines).segments.at(-1);
      const timeline = segment ? timelines.get(segment.videoPath) : undefined;
      if (!segment || !timeline) continue;
      try {
        const still = await materializeEvidenceStill(
          artifactsDir,
          segment,
          timeline,
          traceIndex,
          trace,
        );
        if (still) artifactWriter.register(still);
      } catch (error) {
        // The source clip remains usable; retain the failed derivative as package diagnostics.
        artifactWriter.register({
          path: 'recording-derivatives.json',
          type: 'json',
          category: 'diagnostic',
          label: 'Evidence derivative limitations',
        });
        derivativeIssues.push({ nodeId, error: errorMessage(error) });
      }
    }
    if (derivativeIssues.length)
      await writeFileWithinRoot(
        artifactsDir,
        'recording-derivatives.json',
        JSON.stringify(derivativeIssues),
      );
    const claims: RecipeClaimLedger = {
      schemaVersion: 2,
      recipeRunId,
      criteria: deriveRecipeClaims({
        recipeRunId,
        ...evidencePlan,
        trace,
        artifacts: artifactWriter.list(),
        segments,
        timelines,
      }),
      recording: {
        status:
          videoOptions.mode === 'off'
            ? recordingRequired
              ? 'explicit-off'
              : 'not-required'
            : captureInterruption
              ? 'incomplete'
              : segments.length
                ? 'complete'
                : 'failed',
        ...(videoOptions.reason ? { reason: videoOptions.reason } : {}),
        segments,
      },
    };
    const claimsPath = await writeFileWithinRoot(
      artifactsDir,
      'acceptance-status.json',
      `${JSON.stringify(claims, null, 2)}\n`,
    );
    artifactWriter.register({
      path: 'acceptance-status.json',
      type: 'json',
      category: 'system',
      label: 'Derived claim evidence',
    });
    const summary: SummaryDocument = {
      recipeRunId,
      invocationDigest: digestRecipeDocument(invocation),
      status,
      ...summarizeTraceCounts(trace),
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - startedAt.getTime(),
      harness: {
        name: '@farmslot/recipe-runner',
        version: RECIPE_RUNNER_VERSION,
        action_manifest_schema: this.#actionManifest.$schema,
      },
      ...(this.#runnerProvenance ? { runner: this.#runnerProvenance } : {}),
      ...(libraryResolution
        ? { recipeLibraries: buildRecipeLibrarySummary(libraryResolution) }
        : {}),
      ...(request.selection ? { recipeSelection: request.selection } : {}),
      ...(request.stopAfterNode !== undefined ? { stopAfterNode: request.stopAfterNode } : {}),
    };
    const summaryPath = await summaryWriter.write(summary);
    const artifactManifestPath = await artifactWriter.write(status, this.#runnerProvenance);

    const packageValidation = validateRecordedEvidencePackage({
      invocation,
      recipeRunId,
      claims,
      artifactDigests: Object.fromEntries(
        segments.map((segment) => [segment.videoPath, segment.videoDigest]),
      ),
      timelines: Object.fromEntries(
        segments
          .filter((segment) => segment.timelinePath)
          .map((segment) => [segment.timelinePath!, timelines.get(segment.videoPath)!]),
      ),
      recipe,
      resolvedRecipes: Object.fromEntries(
        [...dependencyResolution.recipes.values()].map((entry) => [
          entry.provenance.digest!,
          entry.document,
        ]),
      ),
      recipeResolution: dependencyResolution.document,
      trace,
      summary,
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

    return {
      status,
      summaryPath,
      tracePath,
      artifactManifestPath,
      recipePath,
      claimsPath,
      claims,
      ...(captureInterruption ? { captureInterruption } : {}),
    };
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
    recording,
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
    recording?: RunVideoRecording;
  }): Parameters<ActionAdapter['execute']>[1] {
    return {
      nodeId,
      recipe,
      projectRoot,
      artifactsDir,
      env,
      outputs,
      getOutput,
      ...(recording?.recording.snapshot
        ? {
            captureRecordingSnapshot: async (relativePath: string) => {
              const relative = normalizeRelativePath(relativePath);
              if (!relative.endsWith('.png'))
                throw new Error('Recording snapshots must use a PNG artifact path.');
              const dir = await mkdtemp(path.join(recording.stagingRoot, 'snapshot-'));
              const staged = path.join(dir, 'frame.png');
              const evidence = await recording.recording.snapshot!(staged);
              await copyFileWithinRoots(dir, 'frame.png', artifactsDir, relative);
              // Keep the provider's source path in its raw sidecar; the action output
              // maps it to the published artifact path without rewriting capture facts.
              return {
                ...evidence,
                sourceOutput: evidence.output,
                output: relative,
                ...(evidence.fallbackFrom
                  ? {}
                  : { videoPath: recordedVideoPath(Number(evidence.segmentIndex ?? 0)) }),
              };
            },
          }
        : {}),
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
      throw new RecipeExecutionError(
        'environment',
        `${recorder.name} doctor ${doctor.code}: ${doctor.message}${
          doctor.suggestedFix ? ` Suggested fix: ${doctor.suggestedFix}` : ''
        }`,
      );
    }
    const node = {
      action: 'record.video',
      intent: 'Record the recipe run when motion proof is useful',
    };
    const resolvedTarget =
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
    if (!resolvedTarget) {
      throw new Error(
        'UI recording requires a target. Provide a project RecordingTargetProvider or disable recording with a reason.',
      );
    }
    const validation = validateRecipeRecordingTarget(resolvedTarget);
    if (validation.status !== 'valid')
      throw new RecipeExecutionError(
        'environment',
        validation.findings.map((finding) => finding.message).join('; '),
      );
    // Admission and backend start use the same immutable provider-resolved identity.
    const target = Object.freeze({ ...resolvedTarget });
    const relativePath = recordedVideoPath(0);
    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), 'farmslot-recipe-video-'));
    const stagingRelativePath = 'recipe-run.mp4';
    const outputPath = path.join(stagingRoot, stagingRelativePath);
    let admission: RecordingAdmissionLease | undefined;
    let releaseFailure: string | undefined;
    let recording: ActiveVideoRecording;
    try {
      admission = await this.#recording?.admission?.acquire({
        backend: recorder.name,
        target,
        projectRoot,
        artifactsDir,
      });
      const backend = await startSegmentedRecording(recorder, {
        outputPath,
        target,
        maxFps: videoOptions.maxFps,
        maxSize: videoOptions.maxSize,
        nodeId: 'recipe-run',
        record: 'full_run',
      });
      recording = {
        ...backend,
        async stop() {
          let result: Awaited<ReturnType<ActiveVideoRecording['stop']>>;
          try {
            result = await backend.stop();
          } catch (error) {
            try {
              await admission?.release();
            } catch (releaseError) {
              throw new AggregateError(
                [error, releaseError],
                'Recording stop and admission release failed.',
              );
            }
            throw error;
          }
          try {
            await admission?.release();
          } catch (error) {
            // Completed originals remain usable; the caller records failed lease cleanup separately.
            releaseFailure = errorMessage(error);
          }
          return result;
        },
      };
    } catch (error) {
      await removePartialRunVideoOutput(outputPath, this.#logger);
      await rm(stagingRoot, { recursive: true, force: true });
      try {
        await admission?.release();
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          'Recording start and admission release failed.',
        );
      }
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
      get releaseFailure() {
        return releaseFailure;
      },
      recording: boundRecording(recording, outputPath, videoOptions),
      entry,
      outputPath,
      stagingRoot,
      stagingRelativePath,
      artifactsDir,
    };
  }

  async #stopRunVideoRecording(
    runRecording: RunVideoRecording,
    traceWriter: JsonTraceWriter,
    artifactWriter: JsonArtifactWriter,
    runStartedAt: Date,
  ): Promise<{
    videos: { entry: RecipeArtifactManifestEntry; timing?: RecipeVideoTiming }[];
    interruption?: RecipeRunCaptureInterruption;
    releaseFailure?: string;
  }> {
    const result = await runRecording.recording.stop();
    const releaseFailure = runRecording.releaseFailure;
    if (releaseFailure)
      traceWriter.record({
        nodeId: 'recipe-run:video',
        action: 'record.video',
        startedAt: runStartedAt.toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - runStartedAt.getTime(),
        ok: false,
        cause_class: 'environment',
        error_code: 'RECORDING_ADMISSION_RELEASE_FAILED',
        error: releaseFailure,
      });
    if (!result.segments.length) throw new Error('Recorder returned no original media segments.');
    const interruption = result.interruption
      ? runCaptureInterruption(result.interruption, recordedVideoPath(result.segments.length - 1))
      : undefined;
    if (interruption) traceWriter.record(captureInterruptedTraceEntry(interruption, runStartedAt));
    const videos: { entry: RecipeArtifactManifestEntry; timing?: RecipeVideoTiming }[] = [];
    for (const [index, segment] of result.segments.entries()) {
      const source = normalizeRelativePath(segment.path);
      await assertVideoOutputReady(path.join(runRecording.stagingRoot, source));
      const relativePath = recordedVideoPath(index);
      await copyFileWithinRoots(
        runRecording.stagingRoot,
        source,
        runRecording.artifactsDir,
        relativePath,
      );
      if (segment.timingEvidencePath && segment.timing) {
        const evidencePath = `${relativePath}.capture.json`;
        await copyFileWithinRoots(
          runRecording.stagingRoot,
          segment.timingEvidencePath,
          runRecording.artifactsDir,
          evidencePath,
        );
        artifactWriter.register({
          path: evidencePath,
          type: 'json',
          category: 'system',
          label: 'Native recording and snapshot timing',
        });
      }
      const entry: RecipeArtifactManifestEntry = {
        ...runRecording.entry,
        path: relativePath,
        sha256: (await digestFileWithinRoot(runRecording.artifactsDir, relativePath)).slice(7),
        ...(segment.recorder ? { recorder: segment.recorder } : {}),
        ...(segment.gapBefore ? { metadata: { gapBefore: true } } : {}),
        ...(result.interruption && index === result.segments.length - 1
          ? { interruption: result.interruption }
          : {}),
        ...(!segment.timing
          ? {
              timelineUnavailableReason:
                segment.timingUnavailableReason ?? 'Recorder does not provide timeline alignment.',
            }
          : {}),
      };
      artifactWriter.register(entry);
      videos.push({ entry, ...(segment.timing ? { timing: segment.timing } : {}) });
    }
    await rm(runRecording.stagingRoot, { recursive: true, force: true });
    return {
      videos,
      ...(interruption ? { interruption } : {}),
      ...(releaseFailure ? { releaseFailure } : {}),
    };
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
        cause_class: 'harness',
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

function recordedVideoPath(index: number): string {
  return index === 0 ? 'videos/recipe-run.mp4' : `videos/recipe-run-${index}.mp4`;
}

interface RunVideoRecording {
  readonly releaseFailure?: string;
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
    .filter((recipe) => !recipe.aliasFor)
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
      (recipe) => !recipe.aliasFor && path.resolve(recipe.path) === resolvedPath,
    );
    if (match) return match.ref;
    return rootResolutionRef(digest);
  }
  return rootResolutionRef(digest);
}

function normalizeVideoRecordingOptions(
  input: RecipeRunRequest['recordVideo'],
  needsUi: boolean,
  reason?: string,
): RecipeVideoRecordingOptions & { mode: 'off' | 'full-run' } {
  if (input === undefined && !needsUi) return { mode: 'off' };
  if (input === false || input === 'off' || (typeof input === 'object' && input.mode === 'off')) {
    const offReason = (typeof input === 'object' ? input.reason : undefined) ?? reason;
    if (needsUi && !offReason?.trim())
      throw new Error('Disabling UI recording requires recordingReason.');
    return { mode: 'off', ...(offReason ? { reason: offReason } : {}) };
  }
  const mode =
    typeof input === 'string'
      ? input
      : typeof input === 'object'
        ? (input.mode ?? 'full-run')
        : 'full-run';
  const options = {
    maxFps: DEFAULT_RECORDED_EVIDENCE_POLICY.maxFps,
    maxSize: DEFAULT_RECORDED_EVIDENCE_POLICY.maxSize,
    maxDurationMs: DEFAULT_RECORDED_EVIDENCE_POLICY.maxDurationMs,
    maxBytes: DEFAULT_RECORDED_EVIDENCE_POLICY.maxBytes,
    ...(typeof input === 'object' ? input : {}),
    mode: normalizeVideoRecordingMode(mode).mode,
  };
  for (const key of ['maxFps', 'maxSize', 'maxDurationMs', 'maxBytes'] as const) {
    if (!Number.isFinite(options[key]) || options[key] <= 0)
      throw new Error(`Recording ${key} must be finite and positive.`);
  }
  if (
    options.maxDurationMs > DEFAULT_RECORDED_EVIDENCE_POLICY.maxDurationMs ||
    options.maxBytes > DEFAULT_RECORDED_EVIDENCE_POLICY.maxBytes
  )
    throw new Error('Recording policy exceeds the execution duration/byte limits.');
  return options;
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
