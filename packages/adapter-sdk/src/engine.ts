import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  digestRecipeDocument,
  type RecipeActionManifestDocument,
  type RecipeExecutionCapability,
  type RecipeExecutionPlan,
  type RecipeSourceProvenance,
} from '@farmslot/protocol';
import {
  type ActionAdapter,
  type ActionResult,
  createRecipeRunner,
  createStandardCoreAdapters,
  createStandardUiAdapters,
  digestFileWithinRoot,
  normalizeUiTransportResult,
  RECIPE_RUNNER_VERSION,
  type RecipeLibrarySource,
  type RecipeRunner,
  type RecipeRunnerProvenance,
  type RecordingAdmission,
} from '@farmslot/recipe-runner';
import { createCdpWebUiTransport } from '@farmslot/recipe-runner/runtime/cdp';
import { createReactNativeBridgeUiTransport } from '@farmslot/recipe-runner/runtime/react-native-bridge';

import {
  type ConsoleAllowlist,
  type ConsoleClassifier,
  createDefaultConsoleClassifier,
} from './diagnostics.js';
import type { CommandOptions, PlatformAdapter, RecipeNodeEvent } from './types.js';

/** Where one resolved action came from. */
export interface ActionCapabilitySource {
  name: string;
  tier: 'official' | 'personal' | 'team' | 'canonical' | 'task';
  manifestPath: string;
  shadows?: string[];
  trust?: RecipeSourceProvenance['trust'];
  implementationRoot?: string;
  digest?: string;
  resolveDigest?: () => Promise<string>;
}

export interface ResolvedActionManifest {
  manifest: RecipeActionManifestDocument;
  actionSources: Map<string, ActionCapabilitySource>;
}

export interface RecipeCatalog {
  /** The library the host ships: its source name, root, and the namespace of its action names. */
  bundledLibrary: { name: string; root: string; actionNamespace: string };
  /**
   * The adapter's action manifest merged across the library sources (the
   * bundled one last), or the override manifest with its task action root.
   */
  resolveActionManifest(
    adapter: string,
    overridePath?: string,
    sources?: readonly RecipeLibrarySource[],
    taskActionRoot?: string,
  ): Promise<ResolvedActionManifest>;
  /** Throws when the manifest document is invalid. */
  validateManifest(manifest: RecipeActionManifestDocument): Promise<unknown>;
  /** CLI libraries and custom catalogs bind their action implementations here. */
  resolveActionAdapter?(
    action: string,
    source: ActionCapabilitySource | undefined,
    options: RecipeRunnerOptions<unknown>,
  ): Promise<ActionAdapter | undefined>;
  /** The execution capabilities the host enforces for a bundled action. */
  actionCapabilities(action: string): readonly RecipeExecutionCapability[];
}

export interface RecipeRunnerOptions<TMutation> {
  captureHudEvidence?: boolean;
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
  runner?: RecipeRunnerProvenance;
  defaultSource?: RecipeSourceProvenance;
  recordingAdmission?: RecordingAdmission;
}

/** Compose the existing SDK and runner contracts without a project engine. */
export function createDefaultRecipeEngine(options: DefaultRecipeEngineOptions): RecipeEngine {
  const { runtime, catalog } = options;
  const runnerRoot = fileURLToPath(new URL('..', import.meta.url));
  const packageMetadata = readFile(new URL('../package.json', import.meta.url), 'utf8').then(
    (text) => JSON.parse(text) as { version: string },
  );
  const entryDir = import.meta.url.endsWith('.ts') ? 'src' : 'dist';
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const runnerDigest = Promise.all(
    ['engine', 'diagnostics', 'types'].map((file) =>
      digestFileWithinRoot(runnerRoot, `${entryDir}/${file}.${extension}`),
    ),
  ).then((digests) => digestRecipeDocument({ digests, runnerVersion: RECIPE_RUNNER_VERSION }));
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
            captureHudEvidence: runnerOptions.captureHudEvidence,
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
      const adapters = [
        ...core.filter((entry) => !codedNames.has(entry.action)),
        ...bindRuntime([...coded, ...ui, ...lifecycle]),
      ];
      const registered = new Set(adapters.map((entry) => entry.action));
      for (const action of declared) {
        if (registered.has(action) || action === 'call' || action === 'end') continue;
        const source = runnerOptions.actionSources.get(action);
        const implementation = await catalog.resolveActionAdapter?.(action, source, runnerOptions);
        if (implementation) adapters.push(...bindRuntime([implementation]));
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
        runner: options.runner ?? {
          name: '@farmslot/adapter-sdk',
          version: (await packageMetadata).version,
          source: runnerRoot,
          git_ref: await runnerDigest,
        },
        adapters: finalAdapters,
        defaultSource: options.defaultSource ?? {
          kind: 'operator',
          trust: 'trusted',
          name: runtime.id,
        },
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
                admission: options.recordingAdmission,
                targetProvider: {
                  resolveRecordingTarget: (context) => runtime.recording!.target(context),
                },
                ...(videoRecorder ? { videoRecorder } : {}),
              },
            }
          : {}),
      });
    },
  };
}
