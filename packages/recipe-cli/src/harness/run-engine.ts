// The recipe execution path `run` and `call` share: one engine door. The host
// supplies its catalog, runner factory, trusted-mutation binding and console
// rules as a `RecipeEngine`; the registered adapters supply platform behavior.
import fs from 'node:fs';
import path from 'node:path';

import type {
  CommandOptions,
  HealBoundViolation,
  HealPolicy,
  HealState,
  PlatformAdapter,
  RecipeNodeEvent,
  RecipeRunOptions,
} from '@farmslot/adapter-sdk';
import type {
  RecipeActionManifestDocument,
  RecipeExecutionPlan,
  RecipeSourceProvenance,
} from '@farmslot/protocol';
import {
  type ActionAdapter,
  type ActionResult,
  createRecipeRunner,
  createStandardCoreAdapters,
  createStandardUiAdapters,
  isCaptureInterruptedEntry,
  loneCaptureInterruption,
  normalizeUiTransportResult,
  readRunTraceEntries,
  type RecipeLibrarySource,
  type RecipeRunner,
  type RecipeRunRequest,
  type RecipeRunResult,
  resolveRecipeTrustInput,
} from '@farmslot/recipe-runner';
import { createCdpWebUiTransport } from '@farmslot/recipe-runner/runtime/cdp';
import { createReactNativeBridgeUiTransport } from '@farmslot/recipe-runner/runtime/react-native-bridge';

import { adapterPortEnv, harnessAdapter } from './adapters.js';
import type { ActionCapabilitySource, RecipeCatalog } from './catalog.js';
import { color } from './cli-color.js';
import { CliError } from './cli-error.js';
import { harnessContextField } from './context-state.js';
import {
  captureExecutionProvenance,
  executionProvenanceDrift,
  type ExecutionProvenanceInput,
  type ExecutionProvenanceSnapshot,
  ProvenanceDriftError,
  writeExecutionProvenance,
} from './execution-provenance.js';
import {
  captureInterruptedViolation,
  checkHealBounds,
  conciseFailureForHuman,
  ensureOverlay,
  newHealState,
  parseHeal,
  recipeRunning,
  recipeRunningRefusal,
} from './heal-bounds.js';
import { harnessHost, hostEnvName, recipeEnvName, withRecipeCleanup } from './host.js';
import { prepareLiveAdapterScript, runLiveAdapterScript } from './live-adapter-contract.js';
import { runNetworkCaptureAction } from './network-observation.js';
import { type CliOptions, isRecord, optionString, shellQuoteArg } from './parse-args.js';
import { recipeRuntimePath } from './paths.js';
import {
  captureHelperSupportsRecordSessionSnapshots,
  createRecordingTargetProvider,
} from './recording-target.js';
import {
  beginRunDiagnostics,
  type ConsoleAllowlist,
  type ConsoleClassifier,
  createDefaultConsoleClassifier,
  finishRunDiagnostics,
  type RecipeRunEvidence,
} from './run-diagnostics.js';
import { startRecipeRecording, stopRecipeRecording } from './run-recording.js';
import { executedBrowser, recipeCdpPorts } from './run-report.js';
import { EXIT } from './shared.js';

export interface RecipeRunnerOptions<TMutation> {
  quietStdout?: boolean;
  suppressLibraryResolutionLogs?: boolean;
  autoHud?: boolean;
  actionSources: ReadonlyMap<string, ActionCapabilitySource>;
  // A direct operator invocation may trust task-local actions.
  trustTaskActions: boolean;
  trustedMutation?: TMutation;
  onActionEvent?(event: RecipeNodeEvent): void;
}

/** What `trustedMutation.load` receives: the run's command line and what the command resolved. */
export interface TrustedMutationLoadInput {
  /** The adapter the command resolved: `--adapter`, a `--platform` target, or the detected one. */
  adapter: string;
  cli: CommandOptions;
  artifactsDir: string;
  projectRoot: string;
  rootRecipe: unknown;
}

/** What `trustedMutation.authorize` receives besides the loaded mutation and the plan. */
export interface TrustedMutationAuthorizeContext {
  /** The adapter the command resolved, the same one `load` received. */
  adapter: string;
}

/** What a host executes recipes with, on top of its catalog. */
export interface RecipeEngine<
  TMutation = unknown,
  TAllowlist extends ConsoleAllowlist = ConsoleAllowlist,
> extends RecipeCatalog {
  createRunner(
    adapter: string,
    manifest: RecipeActionManifestDocument,
    options: RecipeRunnerOptions<TMutation>,
  ): Promise<RecipeRunner>;
  /**
   * Funded external mutations: the context loaded from the run's command line,
   * then bound to the run's execution plan. Absent: no run binds one. The plan is
   * computed without the mutation; `authorize` returning undefined means there is
   * nothing to bind for this plan, and the run executes with no trusted mutation.
   */
  trustedMutation?: {
    /** Validate provider authorization without claims, ledgers or other writes. */
    preflight?(input: TrustedMutationLoadInput, plan: RecipeExecutionPlan): Promise<void>;
    load(input: TrustedMutationLoadInput): Promise<TMutation | undefined>;
    authorize(
      base: TMutation,
      plan: RecipeExecutionPlan,
      context: TrustedMutationAuthorizeContext,
    ): Promise<TMutation | undefined>;
  };
  /** The console rules run diagnostics classify with. */
  console: ConsoleClassifier<TAllowlist>;
  /** The host package paths a run's provenance binds. */
  runnerIncludes: readonly string[];
}

export interface DefaultRecipeEngineOptions {
  runtime: PlatformAdapter;
  catalog: RecipeCatalog;
  runnerIncludes?: readonly string[];
  console?: ConsoleClassifier<ConsoleAllowlist>;
  /** Actual provider/plugin code provenance, independent of declaration precedence. */
  runtimeSource?: RecipeSourceProvenance;
  resolveRuntimeDigest?: () => Promise<string>;
}

/** Compose the existing SDK and runner contracts without a project engine. */
export function createDefaultRecipeEngine(options: DefaultRecipeEngineOptions): RecipeEngine {
  const { runtime, catalog } = options;
  return {
    ...catalog,
    console: options.console ?? createDefaultConsoleClassifier([catalog.bundledLibrary.root]),
    runnerIncludes: options.runnerIncludes ?? ['src', 'dist', 'package.json'],
    async createRunner(adapter, manifest, runnerOptions) {
      if (adapter !== runtime.id)
        throw new Error(`Runtime ${runtime.id} cannot execute ${adapter}.`);
      await catalog.validateManifest(manifest);
      const declared = new Set(Object.keys(manifest.actions));
      const core = createStandardCoreAdapters({ actions: declared });
      const coded = ((await runtime.actions.adapters?.()) ?? []).filter((entry) =>
        declared.has(entry.action),
      );
      const codedNames = new Set(coded.map((entry) => entry.action));
      const runtimeSource = options.runtimeSource ?? {
        kind: 'custom-adapter' as const,
        trust: 'unknown' as const,
        name: runtime.id,
      };
      const bindRuntime = (entries: ActionAdapter[]) =>
        entries.map((entry) => ({
          ...entry,
          source: entry.source ?? runtimeSource,
          ...(!entry.source && !entry.resolveSourceDigest && options.resolveRuntimeDigest
            ? { resolveSourceDigest: options.resolveRuntimeDigest }
            : {}),
        }));
      const transport = runtime.actions.ui?.(
        { createCdpWebUiTransport, createReactNativeBridgeUiTransport },
        {
          hudPolicy: runnerOptions.autoHud === true ? 'show' : 'auto',
        },
      );
      const ui = transport
        ? createStandardUiAdapters({
            actions: [...declared].filter((action) => !codedNames.has(action)),
            transport: transport.base,
          }).map(
            (entry) =>
              ({
                ...entry,
                ...(transport.execute
                  ? {
                      execute: async (node, context) => {
                        let standardResult: ActionResult | undefined;
                        const output = await transport.execute!(
                          entry.action as Parameters<NonNullable<typeof transport.execute>>[0],
                          node,
                          context,
                          async () => {
                            standardResult = await entry.execute(node, context);
                            return standardResult.output;
                          },
                        );
                        const result = normalizeUiTransportResult(output);
                        return {
                          ...standardResult,
                          ...result,
                          artifacts: result.artifacts ?? standardResult?.artifacts,
                          case: result.case ?? standardResult?.case,
                          phases: result.phases ?? standardResult?.phases,
                        };
                      },
                    }
                  : {}),
              }) satisfies ActionAdapter,
          )
        : [];
      const lifecycle = runtime.actions.lifecycle ? await runtime.actions.lifecycle([]) : [];
      const network: ActionAdapter[] =
        runtime.observation?.network?.actions &&
        declared.has('app.network_capture') &&
        !codedNames.has('app.network_capture')
          ? [
              {
                action: 'app.network_capture',
                execute: (node, context) => runNetworkCaptureAction(adapter, node, context),
              },
            ]
          : [];
      const adapters = [
        ...core.filter((entry) => !codedNames.has(entry.action)),
        ...bindRuntime([...coded, ...ui, ...lifecycle, ...network]),
      ];
      const registered = new Set(adapters.map((entry) => entry.action));
      for (const action of declared) {
        if (registered.has(action) || action === 'call' || action === 'end') continue;
        const source = runnerOptions.actionSources.get(action);
        if (!source?.implementationRoot) continue;
        const prepared = await prepareLiveAdapterScript({
          platform: adapter,
          action,
          namespace: catalog.bundledLibrary.actionNamespace,
          implementationRoot: source.implementationRoot,
          allowRuntimeImports:
            source.trust === 'trusted' ||
            (source.tier === 'task' && runnerOptions.trustTaskActions),
        });
        if (!prepared) continue;
        adapters.push({
          action,
          capabilities: [...catalog.actionCapabilities(action)],
          source: {
            kind: source.tier === 'canonical' ? 'bundled' : 'custom-adapter',
            trust:
              source.tier === 'task' && runnerOptions.trustTaskActions
                ? 'trusted'
                : (source.trust ?? 'unknown'),
            name: source.name,
            path: prepared.entryPath,
            digest: prepared.sourceDigest,
          },
          async execute(node, context) {
            const live = await runLiveAdapterScript({
              platform: adapter,
              action,
              namespace: catalog.bundledLibrary.actionNamespace,
              node,
              context,
              prepared,
            });
            if (!live) throw new Error(`Prepared live adapter for ${action} is unavailable.`);
            const output = live.result;
            return {
              output,
              ...(isRecord(output) && typeof output.case === 'string' ? { case: output.case } : {}),
              ...(isRecord(output) && Array.isArray(output.artifacts)
                ? { artifacts: output.artifacts }
                : {}),
            };
          },
        });
      }
      const wrapped = runtime.actions.wrap ? await runtime.actions.wrap(adapters) : adapters;
      const finalAdapters = wrapped.map(
        (entry) =>
          ({
            ...entry,
            capabilities: [
              ...new Set([
                ...(entry.capabilities ?? []),
                ...catalog.actionCapabilities(entry.action),
              ]),
            ],
            ...(runnerOptions.onActionEvent
              ? {
                  async execute(node, context) {
                    const event = { nodeId: context.nodeId, action: entry.action };
                    runnerOptions.onActionEvent!({ ...event, status: 'running' });
                    try {
                      const result = await entry.execute(node, context);
                      runnerOptions.onActionEvent!({ ...event, status: 'passed' });
                      return result;
                    } catch (error) {
                      runnerOptions.onActionEvent!({ ...event, status: 'failed' });
                      throw error;
                    }
                  },
                }
              : {}),
          }) satisfies ActionAdapter,
      );
      const logger = runnerOptions.quietStdout ? new console.Console(process.stderr) : console;
      const videoRecorder = await runtime.recording?.videoRecorder?.();
      return createRecipeRunner({
        actionManifest: manifest,
        adapters: finalAdapters,
        defaultSource: { kind: 'operator', trust: 'trusted', name: harnessHost().packageName },
        logger: {
          info(message) {
            if (
              !runnerOptions.suppressLibraryResolutionLogs ||
              !message.startsWith('Recipe libraries:')
            )
              logger.info(message);
          },
          warn: (message) => logger.warn(message),
          error: (message) => logger.error(message),
        },
        // The runner's HUD needs real app.hud/app.status implementations.
        hud:
          runnerOptions.autoHud === false ||
          runtime.headless ||
          !finalAdapters.some((entry) => entry.action === 'app.hud')
            ? false
            : { enabled: true },
        ...(runtime.recording
          ? {
              recording: {
                targetProvider: createRecordingTargetProvider(adapter),
                ...(videoRecorder ? { videoRecorder } : {}),
              },
            }
          : {}),
      });
    },
  };
}

/** A run's options: the generic ones (with the platform's own) and the command line it came from. */
export type RecipeEngineRunOptions = RecipeRunOptions & {
  signal?: AbortSignal;
  // The engine's trusted mutation reads its own flags from it; `run` passes it,
  // `call` does not.
  cli?: CommandOptions;
  /** Read-only planning/conformance validates authority without publishing execution claims. */
  readOnly?: boolean;
};

export interface PreparedRecipeExecution {
  readOnly?: boolean;
  plan?: RecipeExecutionPlan;
  runner: RecipeRunner;
  runRequest: RecipeRunRequest;
  absoluteArtifactsDir: string;
  useFramedRecording: boolean;
  provenanceInput: ExecutionProvenanceInput;
  provenanceSnapshots: ExecutionProvenanceSnapshot[];
}

/** Execute a recipe inside the caller's `activateRecipeRuntimeEnvironment` scope. */
export async function runRecipe<TMutation, TAllowlist extends ConsoleAllowlist>(
  engine: RecipeEngine<TMutation, TAllowlist>,
  adapter: string,
  recipe: string | object,
  artifactsDir: string,
  projectRoot: string,
  actionManifestPath?: string,
  runtimeOptions: RecipeEngineRunOptions = {},
  preflightedExecution?: PreparedRecipeExecution,
  effectsState: HealState = newHealState(),
): Promise<RecipeRunEvidence> {
  const wasPreflighted = preflightedExecution !== undefined;
  const execution =
    preflightedExecution ??
    (await resolveRecipeExecution(
      engine,
      adapter,
      recipe,
      artifactsDir,
      projectRoot,
      actionManifestPath,
      runtimeOptions,
    ));
  if (execution.readOnly)
    throw new Error('Read-only preflight cannot execute; resolve an executing plan first.');
  const {
    runner,
    runRequest,
    absoluteArtifactsDir,
    useFramedRecording,
    provenanceInput,
    provenanceSnapshots,
  } = execution;
  if (!wasPreflighted) await runner.preflight(runRequest);
  await prepareRuntimeIfNeeded(adapter, projectRoot, runtimeOptions);
  // The prepared runner owns frozen action bundles. Rechecking its plan here
  // does not reconstruct adapters or replace their approved bytes.
  await runner.preflight(runRequest);
  const preExecute = await captureExecutionProvenance(provenanceInput, 'pre-execute');
  provenanceSnapshots.push(preExecute);
  const preExecuteDrift = executionProvenanceDrift(provenanceSnapshots[0]!, preExecute);
  if (preExecuteDrift.length > 0) {
    const provenancePath = await writeExecutionProvenance(
      absoluteArtifactsDir,
      provenanceSnapshots,
      preExecuteDrift,
    );
    throw new ProvenanceDriftError(provenancePath, preExecuteDrift);
  }
  const diagnosticBaseline = await beginRunDiagnostics(adapter, projectRoot);
  const recording = useFramedRecording
    ? await startRecipeRecording(adapter, projectRoot, absoluteArtifactsDir, {
        record: true,
        cdpPort: runtimeOptions.cdpPort,
      })
    : undefined;
  let result: RecipeRunResult | undefined;
  let executionError: unknown;
  try {
    result = await runner.run({
      ...runRequest,
      ...(recording ? { finalizeRecording: () => stopRecipeRecording(recording) } : {}),
    });
  } catch (error) {
    executionError = error;
    try {
      await stopRecipeRecording(recording);
    } catch (recordingError) {
      console.error(
        `WARN: recipe and video recording both failed; preserving recipe failure: ${recordingError instanceof Error ? recordingError.message : String(recordingError)}`,
      );
    }
  } finally {
    // Always clear a HUD step the engine left on-device (a failed run strands
    // the FAIL banner). Best-effort — never masks the run's real outcome.
    const run = harnessAdapter(adapter).run;
    if (run?.teardown) {
      const teardown = () => run.teardown!(projectRoot, recipeRunEnv(adapter, runtimeOptions));
      await (runtimeOptions.signal ? withRecipeCleanup(teardown) : teardown());
    }
  }
  let recordingError: unknown;
  if (executionError === undefined && result) {
    try {
      const captureInterruption = await stopRecipeRecording(recording, result);
      // The partial video is published; the run fails with a typed capture failure.
      if (captureInterruption) result = { ...result, status: 'fail', captureInterruption };
    } catch (error) {
      recordingError = error;
    }
  }
  const end = await captureExecutionProvenance(provenanceInput, 'end');
  provenanceSnapshots.push(end);
  const endDrift = executionProvenanceDrift(provenanceSnapshots[0]!, end);
  const provenancePath = await writeExecutionProvenance(
    absoluteArtifactsDir,
    provenanceSnapshots,
    endDrift,
    result?.artifactManifestPath,
  );
  if (endDrift.length > 0) {
    throw new ProvenanceDriftError(provenancePath, endDrift, executionError);
  }
  if (executionError !== undefined) throw executionError;
  if (recordingError !== undefined) throw recordingError;
  if (!result) throw new Error('Recipe execution returned no result.');
  const finalized = await finishRunDiagnostics(diagnosticBaseline, result, engine.console);
  persistRunEffects(finalized.summaryPath, finalized.artifactManifestPath, effectsState);
  const browser = executedBrowser(
    adapter,
    projectRoot,
    finalized.artifactManifestPath,
    recipeCdpPorts(runRequest),
  );
  return browser ? { ...finalized, browser } : finalized;
}

/** Resolve and preflight a recipe inside the caller's `activateRecipeRuntimeEnvironment` scope. */
export async function preflightRecipe<TMutation, TAllowlist extends ConsoleAllowlist>(
  engine: RecipeEngine<TMutation, TAllowlist>,
  adapter: string,
  recipe: string | object,
  artifactsDir: string,
  projectRoot: string,
  actionManifestPath?: string,
  runtimeOptions: RecipeEngineRunOptions = {},
): Promise<PreparedRecipeExecution> {
  const execution = await resolveRecipeExecution(
    engine,
    adapter,
    recipe,
    artifactsDir,
    projectRoot,
    actionManifestPath,
    runtimeOptions,
  );
  const plan = execution.plan ?? (await execution.runner.preflight(execution.runRequest));
  return { ...execution, plan };
}

/** Record the run's recoveries and mutations in its summary and artifact manifest. */
export function persistRunEffects(
  summaryPath: string,
  artifactManifestPath: string,
  state: HealState,
): void {
  for (const filePath of [summaryPath, artifactManifestPath]) {
    let document: unknown;
    try {
      document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      document = null;
    }
    if (!isRecord(document)) {
      throw new Error(`Recipe evidence file is not valid JSON: ${filePath}`);
    }
    document.recovered = [...state.recovered];
    document.mutations = state.mutations.map((mutation) => ({ ...mutation }));
    fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`);
  }
}

async function resolveRecipeExecution<TMutation, TAllowlist extends ConsoleAllowlist>(
  engine: RecipeEngine<TMutation, TAllowlist>,
  adapter: string,
  recipe: string | object,
  artifactsDir: string,
  projectRoot: string,
  actionManifestPath: string | undefined,
  runtimeOptions: RecipeEngineRunOptions,
): Promise<PreparedRecipeExecution> {
  const absoluteArtifactsDir = path.resolve(artifactsDir);
  const absoluteRecipePath = typeof recipe === 'string' ? path.resolve(recipe) : undefined;
  const recordVideo = runtimeOptions.recordVideo ?? false;
  const trust = resolveRecipeTrustInput({
    sourceTrust: runtimeOptions.source?.trust,
    sourceKind: runtimeOptions.source?.kind,
    sourceName: runtimeOptions.source?.name,
    sourceDigest: runtimeOptions.source?.digest,
    approvalDigest: runtimeOptions.approval?.planDigest,
  });
  const librarySources = executionLibrarySources(
    engine,
    runtimeOptions.librarySources,
    trust.source?.trust ?? 'trusted',
  );
  const { manifest, actionSources } = await engine.resolveActionManifest(
    adapter,
    actionManifestPath,
    librarySources,
    process.env[recipeEnvName('LIVE_ADAPTER_DIR')],
  );
  const recipeDocument = runtimeRecipeDocument(recipe, absoluteRecipePath);
  const mutation = engine.trustedMutation;
  const mutationInput: TrustedMutationLoadInput = {
    adapter,
    cli: runtimeOptions.cli ?? {},
    artifactsDir: absoluteArtifactsDir,
    projectRoot,
    rootRecipe: recipeDocument,
  };
  const trustedMutation =
    mutation && !runtimeOptions.readOnly ? await mutation.load(mutationInput) : undefined;
  const surface = harnessAdapter(adapter);
  const suppressAutoHud = surface.run?.autoHud?.() === false;
  const runnerOptions = {
    quietStdout: runtimeOptions.stdoutIsMachineContract === true,
    suppressLibraryResolutionLogs: runtimeOptions.suppressLibraryResolutionLogs,
    // Every source follows the run's HUD policy: the runner owns the HUD node
    // and binds it in the plan an untrusted source's approval covers.
    autoHud: suppressAutoHud ? false : runtimeOptions.autoHud,
    onActionEvent: runtimeOptions.onActionEvent,
    actionSources,
    // A direct engineer invocation is the explicit trust boundary for a
    // task-local adapter. Inherited gateway provenance remains authoritative,
    // so an untrusted worker cannot promote itself with CLI flags.
    trustTaskActions: (trust.source?.trust ?? 'trusted') === 'trusted',
  };
  // The loaded mutation is not bound to a plan yet, so the runner that computes
  // the plan gets none; only an authorized mutation reaches execution.
  let runner = await engine.createRunner(adapter, manifest, runnerOptions);
  // The wrapper-owned framed recorder is outside the generic execution plan.
  // Keep it for trusted operator runs only; restricted sources use the generic
  // recorder so capture remains plan-bound and approval-gated.
  const useFramedRecording =
    surface.recording?.framed !== undefined &&
    recordVideo === 'full-run' &&
    trust.source?.trust !== 'untrusted' &&
    trust.source?.trust !== 'unknown' &&
    captureHelperSupportsRecordSessionSnapshots(projectRoot);
  const runRequest: RecipeRunRequest = {
    signal: runtimeOptions.signal,
    ...(recipeDocument !== undefined
      ? { recipeDocument }
      : absoluteRecipePath
        ? { recipePath: absoluteRecipePath }
        : { recipeDocument: recipe }),
    artifactsDir: absoluteArtifactsDir,
    projectRoot,
    inheritProcessEnv: false,
    env: {
      ...recipeProcessEnvironment(),
      ...recipeRunEnv(adapter, runtimeOptions),
      [recipeEnvName('ACTION_SOURCE_MAP')]: actionSourceMap(actionSources),
    },
    recordVideo: useFramedRecording ? false : recordVideo,
    ...trust,
    ...(librarySources ? { librarySources } : {}),
    adapter,
    ...(runtimeOptions.params ? { params: runtimeOptions.params } : {}),
  };
  let plan: RecipeExecutionPlan | undefined;
  if (runtimeOptions.readOnly) {
    plan = await runner.preflight(runRequest);
    if (mutation && !mutation.preflight)
      throw Object.assign(
        new CliError('The provider has no read-only mutation authorization preflight.', EXIT.usage),
        {
          code: 'MUTATION_PREFLIGHT_UNAVAILABLE',
          userAction:
            'upgrade the provider to support read-only mutation preflight before planning or certification',
        },
      );
    await mutation?.preflight?.(mutationInput, plan);
  } else if (mutation && trustedMutation) {
    const executionPlan = await runner.preflight(runRequest);
    const authorizedMutation = await mutation.authorize(trustedMutation, executionPlan, {
      adapter,
    });
    if (authorizedMutation !== undefined) {
      runner = await engine.createRunner(adapter, manifest, {
        ...runnerOptions,
        trustedMutation: authorizedMutation,
      });
    }
  }
  const provenanceInput: ExecutionProvenanceInput = {
    adapter,
    projectRoot,
    recipeDocument: recipeDocument ?? recipe,
    ...(absoluteRecipePath ? { recipePath: absoluteRecipePath } : {}),
    ...(librarySources ? { librarySources } : {}),
    excludedProductRoots: [
      absoluteArtifactsDir,
      recipeRuntimePath(projectRoot, 'operations'),
      recipeRuntimePath(projectRoot, 'lock-members'),
    ],
    helperPaths: commandHelperPaths(recipeDocument ?? recipe, projectRoot),
    runnerIncludes: engine.runnerIncludes,
  };
  const provenanceSnapshots = runtimeOptions.readOnly
    ? []
    : [await captureExecutionProvenance(provenanceInput, 'start')];
  return {
    readOnly: runtimeOptions.readOnly === true,
    ...(plan ? { plan } : {}),
    runner,
    absoluteArtifactsDir,
    useFramedRecording,
    runRequest,
    provenanceInput,
    provenanceSnapshots,
  };
}

function commandHelperPaths(recipe: unknown, projectRoot: string): string[] {
  const helpers = new Set<string>();
  visitRecipeValues(recipe, (value) => {
    if (!isRecord(value) || value.action !== 'command' || typeof value.cmd !== 'string') return;
    const candidates = commandHelperTokens(value.cmd);
    for (const token of candidates) {
      if (/[$`{}]/u.test(token)) {
        throw new Error(`Command helper path cannot be bound before execution: ${token}`);
      }
      if (!isHelperToken(token)) continue;
      const absolute = path.isAbsolute(token)
        ? path.resolve(token)
        : path.resolve(projectRoot, token);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch {
        throw new Error(`Command helper source does not exist: ${token}`);
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`Command helper source must be a regular file: ${token}`);
      }
      helpers.add(absolute);
    }
  });
  return [...helpers].sort();
}

function commandHelperTokens(command: string, depth = 0): Set<string> {
  if (depth > 4) {
    throw new Error('Command helper sources exceed the supported shell nesting depth.');
  }
  const tokens = shellTokens(command);
  const candidates = new Set(tokens.filter(isHelperToken));
  for (const token of tokens) {
    const assignment =
      /^(?:--)?(?:config|configuration|manifest|project|recipe|schema|tsconfig)=([^=]+)$/iu.exec(
        token,
      );
    const value = assignment?.[1];
    if (value && (isHelperToken(value) || isConfigInputToken(value))) {
      candidates.add(value);
    }
  }
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (!isScriptInterpreter(tokens[index]!)) continue;
    const option = tokens[index + 1]!;
    if (
      isShellInterpreter(tokens[index]!) &&
      /^-[a-z]*c[a-z]*$/iu.test(option) &&
      tokens[index + 2]
    ) {
      for (const nested of commandHelperTokens(tokens[index + 2]!, depth + 1)) {
        candidates.add(nested);
      }
      continue;
    }
    if (!option.startsWith('-')) candidates.add(option);
  }
  return candidates;
}

function visitRecipeValues(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const child of value) visitRecipeValues(child, visit);
    return;
  }
  if (!isRecord(value)) return;
  for (const child of Object.values(value)) visitRecipeValues(child, visit);
}

function isHelperToken(token: string): boolean {
  return (
    !token.startsWith('-') &&
    !token.includes('=') &&
    !/^[a-z][a-z0-9+.-]*:\/\//iu.test(token) &&
    /^\S+\.(?:cjs|mjs|js|jsx|ts|tsx|sh|py)$/u.test(token)
  );
}

function isConfigInputToken(token: string): boolean {
  return (
    !token.startsWith('-') &&
    !token.includes('=') &&
    /^\S+\.(?:json|json5|ya?ml|toml)$/u.test(token)
  );
}

function isScriptInterpreter(token: string): boolean {
  return /^(?:node|bash|sh|python|python3)$/u.test(path.basename(token));
}

function isShellInterpreter(token: string): boolean {
  return /^(?:bash|sh)$/u.test(path.basename(token));
}

function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (token) tokens.push(token);
    token = '';
  };
  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s|[;&|<>]/u.test(character)) push();
    else token += character;
  }
  if (quote || escaped) {
    throw new Error('Command helper sources cannot be bound from an unterminated shell token.');
  }
  push();
  return tokens;
}

function runtimeRecipeDocument(
  recipe: string | object,
  absoluteRecipePath: string | undefined,
): unknown {
  if (typeof recipe !== 'string') return recipe;
  if (!absoluteRecipePath || !fs.existsSync(absoluteRecipePath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(absoluteRecipePath, 'utf8'));
  } catch {
    return undefined;
  }
}

// The run's child environment: this process's, without the host's checkout
// lock and operation identity.
function recipeProcessEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[hostEnvName('CHECKOUT_LOCK_TOKEN')];
  delete env[hostEnvName('OPERATION_ID')];
  return env;
}

function executionLibrarySources(
  catalog: RecipeCatalog,
  sources: RecipeLibrarySource[] | undefined,
  invocationTrust: 'trusted' | 'untrusted' | 'unknown',
): RecipeLibrarySource[] | undefined {
  return sources?.map((source) => {
    if (source.name === catalog.bundledLibrary.name) return source;
    return {
      ...source,
      provenance: {
        ...source.provenance,
        kind: source.provenance?.kind ?? 'library',
        trust: invocationTrust === 'trusted' ? 'trusted' : 'unknown',
        name: source.provenance?.name ?? source.name ?? path.basename(source.root),
      },
    };
  });
}

// The ports every run sets: CDP, the watcher, and each registered adapter's
// dev-server port names.
function runEnvKeys(): string[] {
  return ['CDP_PORT', 'RECIPE_CDP_PORT', 'WATCHER_PORT', ...adapterPortEnv()];
}

/**
 * The run's ports and platform environment: the slot's ports, then the explicit
 * ones, then the platform's own. `run` and `call` open one scope around
 * preflight, the runtime check, the observers and the execution, so all of them
 * see the same ports. Returns the restore.
 */
export function activateRecipeRuntimeEnvironment(
  adapter: string,
  projectRoot: string,
  runtimeOptions: RecipeRunOptions,
): () => void {
  const surface = harnessAdapter(adapter);
  // Restored when the run ends: the keys every run sets, plus the ones the
  // platform's run may change (slot ports, its activateEnv).
  const previousEnv = Object.fromEntries(
    [...runEnvKeys(), ...(surface.run?.envKeys ?? [])].map((key) => [key, process.env[key]]),
  );
  const pinnedEnv = surface.run?.pinnedEnv?.();
  // Every engine execution resolves the slot's ports/device first (context →
  // pool → formula), so call/run/fixtures get the same slot isolation launch
  // has; explicit runtimeOptions below still override.
  surface.resolveSlotPorts(projectRoot);
  // Slot resolution owns ports, but an explicit --device selection owns the
  // device. Restore that pin after the slot context is loaded so HUD and live
  // adapter child processes cannot drift back to the slot's default device.
  if (pinnedEnv) {
    for (const [key, value] of Object.entries(pinnedEnv)) {
      restoreEnv(key, value);
    }
  }
  if (runtimeOptions.cdpPort) {
    process.env.CDP_PORT = runtimeOptions.cdpPort;
    process.env.RECIPE_CDP_PORT = runtimeOptions.cdpPort;
  }
  if (runtimeOptions.watcherPort) {
    process.env.WATCHER_PORT = runtimeOptions.watcherPort;
    for (const name of adapterPortEnv()) process.env[name] = runtimeOptions.watcherPort;
  }
  surface.run?.activateEnv?.(projectRoot, runtimeOptions);
  return () => {
    for (const [key, value] of Object.entries(previousEnv)) restoreEnv(key, value);
  };
}

// Where each non-official action's implementation lives, for live adapter scripts.
function actionSourceMap(sources: ReadonlyMap<string, ActionCapabilitySource>): string {
  const roots: Record<string, string> = {};
  for (const [action, source] of sources) {
    if (source.tier === 'official') continue;
    roots[action] =
      source.implementationRoot ??
      (source.tier === 'task'
        ? path.join(path.dirname(source.manifestPath), 'actions')
        : path.join(path.dirname(path.dirname(source.manifestPath)), 'actions'));
  }
  return JSON.stringify(roots);
}

function recipeRunEnv(
  adapter: string,
  runtimeOptions: RecipeRunOptions = {},
): Record<string, string | undefined> {
  const explicitPlatform = hostEnvName('EXPLICIT_PLATFORM');
  const base: Record<string, string | undefined> = {
    CDP_PORT: runtimeOptions.cdpPort ?? process.env.CDP_PORT,
    RECIPE_CDP_PORT: runtimeOptions.cdpPort ?? process.env.RECIPE_CDP_PORT,
    FARMSLOT_SLOT_ID: runtimeOptions.slot ?? process.env.FARMSLOT_SLOT_ID,
    SLOT_ID: runtimeOptions.slot ?? process.env.SLOT_ID,
    PLATFORM: process.env.PLATFORM,
    [explicitPlatform]: process.env[explicitPlatform],
  };
  const run = harnessAdapter(adapter).run;
  return run?.childEnv ? run.childEnv(base) : base;
}

export async function prepareRuntimeIfNeeded(
  adapter: string,
  projectRoot: string,
  runtimeOptions: RecipeRunOptions,
): Promise<void> {
  await harnessAdapter(adapter).run?.prepareRuntime?.(projectRoot, runtimeOptions);
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** A one-node recipe that runs `action` with `args` through the real engine path. */
export function synthesizeOneNodeRecipe(
  action: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const host = harnessHost().name;
  return {
    $schema: 'https://farmslot.io/schemas/recipe-v1.schema.json',
    title: `${host} call ${action}`,
    description: `Ad-hoc single-action execution of ${action} via the real engine path (${host} call).`,
    workflow: {
      entry: 'call',
      nodes: {
        call: {
          ...args,
          action,
          next: 'done',
          intent:
            typeof args.intent === 'string'
              ? args.intent
              : `Complete the requested ${action} operation`,
        },
        done: { action: 'end', status: 'pass' },
      },
    },
  };
}

interface PreparedHeal {
  state: HealState;
  heal: HealPolicy;
}

interface PrepareHealOptions {
  // The caller authored an app restart, so the loaded source may be stale.
  appRestartAuthored?: boolean;
  onPhase?: (
    phase: 'install' | 'healthcheck' | 'recover',
    fields?: Record<string, unknown>,
  ) => void;
}

/**
 * Refuse a concurrent recipe, parse --heal, ensure the runtime overlay, and run
 * the platform's runtime check: the heal state to run with, or the exit code.
 */
export async function prepareHeal(
  adapter: string,
  target: string,
  options: CliOptions,
  json: boolean,
  prepareOptions: PrepareHealOptions = {},
): Promise<PreparedHeal | number> {
  const host = harnessHost().name;
  if (recipeRunning(target)) {
    const { message: msg, userAction } = recipeRunningRefusal(shellQuoteArg(target));
    if (json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            status: 'fail',
            recoverable: false,
            error: { code: 'RECIPE_RUNNING', message: msg, userAction },
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗ ${host}: ${msg}\n  Next: ${userAction}`);
    }
    return EXIT.bounded;
  }

  const healValue = optionString(options, 'heal');
  const healOpts: Record<string, string | boolean> = {};
  if (healValue !== undefined) healOpts.heal = healValue;
  const heal = parseHeal(healOpts, 'infra-only');
  if (typeof heal !== 'string') {
    console.error(heal.error);
    return EXIT.usage;
  }
  const state = newHealState();
  const runtimeCheck = harnessAdapter(adapter).run?.runtimeCheck?.({
    target,
    options,
    heal,
    state,
    json,
    appRestartAuthored: prepareOptions.appRestartAuthored,
    onRecovery: (code) => prepareOptions.onPhase?.('recover', { code }),
  });
  prepareOptions.onPhase?.('install');
  const ensured = await ensureOverlay(adapter, target, heal, state, json);
  if (!ensured.ok) {
    const userAction = `${host} install --adapter ${adapter} --target ${shellQuoteArg(target)}`;
    if (json) {
      console.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            status: 'fail',
            recoverable: false,
            mutations: state.mutations,
            error: {
              code: 'OVERLAY_INSTALL_FAILED',
              message: ensured.error,
              userAction,
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.error(`✗ overlay auto-ensure failed: ${ensured.error}\n  Next: ${userAction}`);
    }
    return EXIT.infra;
  }
  prepareOptions.onPhase?.('healthcheck');
  if (runtimeCheck) {
    const current = await runtimeCheck();
    if (current !== null) return current;
  }
  return { state, heal };
}

// Failure text to classify. A capture interruption is reported on its own (captureInterruptedViolation).
function readRunFailureText(result: RecipeRunResult): string {
  const entries = (readRunTraceEntries(result.tracePath) ?? []) as Array<{
    ok?: boolean;
    error?: unknown;
  }>;
  return entries
    .filter(
      (entry) =>
        entry &&
        entry.ok === false &&
        typeof entry.error === 'string' &&
        !isCaptureInterruptedEntry(entry),
    )
    .map((entry) => entry.error as string)
    .join('\n')
    .trim();
}

/** Run once; a failed run is classified against the recovery bounds. */
export async function executeWithHealBounds<T extends RecipeRunResult>(
  exec: () => Promise<T>,
  target: string,
  state: HealState,
): Promise<{ result: T; violation: HealBoundViolation | null }> {
  const result = await exec();
  if (result.status === 'pass' || result.status === 'unknown') return { result, violation: null };
  // A lone capture interruption is typed; any other failure is classified as usual.
  const interruption = loneCaptureInterruption(result);
  if (interruption) return { result, violation: captureInterruptedViolation(interruption) };
  return { result, violation: checkHealBounds(target, readRunFailureText(result), state) };
}

/** Evidence an action produced through a fallback provider (artifact `metadata.fallbackFrom`). */
export interface RunFallbackEvidence {
  path: string;
  label: string;
  fallbackFrom: string;
  fallbackReason?: string;
}

export function fallbackMarker(
  fallback: Pick<RunFallbackEvidence, 'fallbackFrom' | 'fallbackReason'>,
): string {
  return `(fallback from ${fallback.fallbackFrom}${fallback.fallbackReason ? `: ${fallback.fallbackReason}` : ''})`;
}

/** The error a run or call reports for a heal-bound violation, in --json and --json-stream alike. */
export function healViolationError(violation: HealBoundViolation, userAction: string) {
  return {
    code: violation.code,
    message: violation.message,
    retryable: violation.retryable ?? false,
    userAction,
    originalError: violation.originalError ?? null,
  };
}

export function emitHealViolation(
  json: boolean,
  command: 'run' | 'call',
  result: Pick<RecipeRunResult, 'summaryPath' | 'tracePath' | 'artifactManifestPath'>,
  violation: HealBoundViolation,
  state: HealState,
  adapter?: string,
  fallbacks: RunFallbackEvidence[] = [],
  reportPath?: string,
): number {
  const userAction =
    (adapter ? harnessAdapter(adapter).run?.violationUserAction?.(violation) : undefined) ??
    violation.userAction ??
    `inspect ${shellQuoteArg(result.summaryPath)} and ${shellQuoteArg(result.tracePath)}; fix the application or recipe failure before retrying`;
  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          command,
          ...harnessContextField(),
          status: 'fail',
          recoverable: false,
          recovered: state.recovered,
          mutations: state.mutations,
          attemptedRecoveries: state.attemptedRecoveries,
          summaryPath: result.summaryPath,
          tracePath: result.tracePath,
          artifactManifestPath: result.artifactManifestPath,
          ...(reportPath ? { reportPath } : {}),
          ...(fallbacks.length > 0 ? { fallbacks } : {}),
          exitCode: violation.exitCode,
          error: healViolationError(violation, userAction),
        },
        null,
        2,
      ),
    );
  } else {
    const message =
      violation.code === 'APP_LOGIC_FAILURE' && violation.originalError
        ? conciseFailureForHuman(violation.originalError)
        : violation.message;
    console.error(
      `✗ ${harnessHost().name} ${command}: ${message}` +
        (violation.originalError && violation.code !== 'APP_LOGIC_FAILURE'
          ? `\n  --- original failure ---\n${violation.originalError}`
          : '') +
        (userAction ? `\n  Next: ${userAction}` : ''),
    );
    for (const fallback of fallbacks) {
      console.error(
        `  ${fallback.label}: ${fallback.path} ${color('warn', fallbackMarker(fallback), { stream: process.stderr })}`,
      );
    }
  }
  return violation.exitCode;
}

/**
 * A recipe's node count: `workflow.nodes` in recipe v1 (a `call` node counts
 * once), or the arrays older recipes kept (`nodes`, `steps`, or
 * `workflow.<phase>[]`). Undefined when the document has none of these.
 */
export function countRecipeNodes(recipe: unknown): number | undefined {
  if (!isRecord(recipe)) return undefined;
  if (Array.isArray(recipe.nodes)) return recipe.nodes.length;
  if (Array.isArray(recipe.steps)) return recipe.steps.length;
  if (!isRecord(recipe.workflow)) return undefined;
  const graph = recipe.workflow.nodes;
  if (isRecord(graph)) return Object.keys(graph).length;
  const phases = Object.values(recipe.workflow).filter((value) => Array.isArray(value));
  return phases.length > 0 ? phases.reduce((total, phase) => total + phase.length, 0) : undefined;
}
