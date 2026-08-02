import os from 'node:os';
import path from 'node:path';

import {
  digestRecipeDocument,
  getRecipeActionManifestActionNames,
  isRecord,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';
import {
  applyTaskLocalInvocationTrust,
  createCaptureHelperVideoRecorder,
  createRecipeRunner,
  createStandardUiAdapters,
  loadRecipeLibraries,
  type RecipeLibrarySource,
  type RecipeVideoRecordingOptions,
  type RecordingTarget,
  type RecordingTargetProvider,
  resolveRecipeDependencies,
  resolveRecipeLibrarySources,
  resolveRecipeTrustInput,
  rootResolutionRef,
  type UiActionTransport,
  type VideoRecorder,
} from '@farmslot/recipe-harness';
import {
  parsePositiveInteger,
  resolveRecipeCliPath,
  validateRecipeCliInput,
} from '@farmslot/recipe-harness/cli/support';

import {
  type AgentDeviceUiTransport,
  createAgentDeviceUiTransport,
  NATIVE_UI_ACTIONS,
} from './agent-device-ui-transport.js';
import { DEFAULT_EXPO_RECIPE_MANIFEST_PATH, DEFAULT_EXPO_RECIPE_PATH } from './constants.js';
import { readJsonFile } from './json.js';
import {
  createMetroRecipeBridgeUiTransport,
  resolveMetroRecipeBridgePort,
} from './metro-recipe-bridge-transport.js';
import { createRedactingCoreAdapters } from './redaction.js';
import { createSimctlVideoRecorder } from './simctl-video-recorder.js';

export interface ExpoRecipeRunOptions {
  projectRoot?: string;
  manifestPath?: string;
  artifactsDir?: string;
  dryRun?: boolean;
  json?: boolean;
  recordVideo?: boolean | RecipeVideoRecordingOptions;
  metroHost?: string;
  metroPort?: number;
  params?: Record<string, unknown>;
}

export async function validateExpoRecipeDocument(
  recipePath: string = DEFAULT_EXPO_RECIPE_PATH,
  options: ExpoRecipeRunOptions = {},
) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const recipeAbsolutePath = resolveRecipeCliPath(recipePath, projectRoot);
  const librarySources = await resolveRecipeLibrarySources({ recipePath: recipeAbsolutePath });
  const platform = normalizeRecipeAdapter(process.env.PLATFORM);
  return validateRecipeCliInput({
    recipePath: recipeAbsolutePath,
    actionManifestPath: options.manifestPath ?? DEFAULT_EXPO_RECIPE_MANIFEST_PATH,
    ...(platform ? { adapter: platform } : {}),
    baseDir: projectRoot,
    artifactDir: options.artifactsDir,
    ...(librarySources.length ? { librarySources } : {}),
    ...(options.params ? { params: options.params } : {}),
  });
}

export async function runExpoRecipeDocument(
  recipePath: string = DEFAULT_EXPO_RECIPE_PATH,
  options: ExpoRecipeRunOptions = {},
) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const manifestPath = resolveRecipeCliPath(
    options.manifestPath ?? DEFAULT_EXPO_RECIPE_MANIFEST_PATH,
    projectRoot,
  );
  const recipeAbsolutePath = resolveRecipeCliPath(recipePath, projectRoot);
  const artifactsDir = resolveRecipeCliPath(
    options.artifactsDir ?? defaultArtifactsDir(recipePath),
    projectRoot,
  );

  const manifest = (await readJsonFile(manifestPath)) as RecipeActionManifestDocument;
  const platform = normalizeRecipeAdapter(process.env.PLATFORM);
  const actions = getRecipeActionManifestActionNames(manifest);
  const trust = resolveRecipeTrustInput();
  const invocationTrust = trust.source?.trust ?? 'trusted';
  const librarySources: RecipeLibrarySource[] = applyTaskLocalInvocationTrust(
    await resolveRecipeLibrarySources({ recipePath: recipeAbsolutePath }),
    invocationTrust,
  );
  if (!options.dryRun && platform !== 'web') {
    await assertNativeRecipeContext(recipeAbsolutePath, librarySources, process.env);
  }
  const transport = createExpoUiTransport(options);
  const adapters = [
    ...createRedactingCoreAdapters(actions),
    ...createStandardUiAdapters({
      actions,
      transport,
    }),
  ];

  const runner = createRecipeRunner({
    actionManifest: manifest,
    adapters,
    defaultSource: {
      kind: 'operator',
      trust: 'trusted',
      name: '@farmslot/expo-recipe',
    },
    hud: false,
    runner: {
      source: '@farmslot/expo-recipe',
      git_ref: 'package',
      name: '@farmslot/expo-recipe',
    },
    logger: console,
    recording: {
      targetProvider: createExpoRecordingTargetProvider(),
      videoRecorder: resolveExpoVideoRecorder(process.env),
    },
  });

  try {
    return await runner.run({
      recipePath: recipeAbsolutePath,
      artifactsDir,
      projectRoot,
      ...(librarySources.length ? { librarySources } : {}),
      ...(options.params ? { params: options.params } : {}),
      ...(platform ? { adapter: platform } : {}),
      env: {
        FARMSLOT_RECIPE_ARTIFACTS_DIR: artifactsDir,
      },
      recordVideo: options.recordVideo,
      ...trust,
    });
  } finally {
    await closeUiTransportQuietly(transport);
  }
}

async function assertNativeRecipeContext(
  recipePath: string,
  librarySources: RecipeLibrarySource[],
  env: Record<string, string | undefined>,
): Promise<void> {
  const root = await readJsonFile(recipePath);
  if (!isRecord(root)) return;
  const libraries = await loadRecipeLibraries(librarySources);
  const digest = digestRecipeDocument(root);
  const dependencies = resolveRecipeDependencies({
    rootRef: rootResolutionRef(digest),
    root,
    rootSource: { kind: 'operator', trust: 'trusted', path: recipePath, digest },
    recipes: libraries.recipes,
  });
  const documents = [root, ...[...dependencies.recipes.values()].map((entry) => entry.document)];
  if (!documents.some(recipeUsesNativeUi)) return;

  const platform = normalizeNativePlatform(env.PLATFORM);
  if (!platform) {
    throw new Error(
      'Native recipe actions require PLATFORM=ios or android from the assigned slot.',
    );
  }
  const device =
    platform === 'ios'
      ? (env.IOS_SIMULATOR ?? env.SIMULATOR)
      : (env.ADB_SERIAL ?? env.ANDROID_SERIAL ?? env.ANDROID_DEVICE);
  if (!device) {
    throw new Error(
      platform === 'ios'
        ? 'Native iOS recipe actions require IOS_SIMULATOR or SIMULATOR from the assigned slot.'
        : 'Native Android recipe actions require ADB_SERIAL from the assigned slot.',
    );
  }
  if (!env.FARMSLOT_RECIPE_APP_ID) {
    throw new Error('Native recipe actions require FARMSLOT_RECIPE_APP_ID for the target app.');
  }
}

function recipeUsesNativeUi(recipe: Record<string, unknown>): boolean {
  const workflow = isRecord(recipe.workflow) ? recipe.workflow : {};
  const nodes = isRecord(workflow.nodes) ? Object.values(workflow.nodes) : [];
  return nodes.some(
    (node) => isRecord(node) && typeof node.action === 'string' && isNativeUiAction(node.action),
  );
}

export async function closeUiTransportQuietly(transport: {
  close?(): Promise<unknown> | void;
}): Promise<void> {
  try {
    await transport.close?.();
  } catch (error) {
    // Cleanup must never convert a passing run to failure or mask the original run error.
    console.warn(
      `Native recipe transport cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function createExpoRecordingTargetProvider(): RecordingTargetProvider {
  return {
    async resolveRecordingTarget() {
      return resolveExpoRecordingTarget(process.env);
    },
  };
}

export function resolveExpoRecordingTarget(
  env: Record<string, string | undefined>,
): RecordingTarget {
  if (env.FARMSLOT_RECORD_PID)
    return { kind: 'pid', pid: parsePositiveInteger(env.FARMSLOT_RECORD_PID) };
  if (env.FARMSLOT_RECORD_WINDOW_ID) {
    return { kind: 'window-id', windowId: env.FARMSLOT_RECORD_WINDOW_ID };
  }
  const simulator = env.SIMULATOR ?? env.IOS_SIMULATOR;
  if (simulator) return { kind: 'simulator', device: simulator };
  const appName = env.FARMSLOT_RECORD_APP_NAME ?? 'Simulator';
  const windowName = env.FARMSLOT_RECORD_WINDOW_NAME ?? 'Simulator';
  return { kind: 'app-window', appName, windowName };
}

export function resolveExpoVideoRecorder(env: Record<string, string | undefined>): VideoRecorder {
  if (
    env.FARMSLOT_RECORD_PID ||
    env.FARMSLOT_RECORD_WINDOW_ID ||
    env.FARMSLOT_RECORD_APP_NAME ||
    env.FARMSLOT_RECORD_WINDOW_NAME
  ) {
    return createCaptureHelperVideoRecorder();
  }
  const target = resolveExpoRecordingTarget(env);
  if (target.kind === 'simulator') return createSimctlVideoRecorder();
  return createCaptureHelperVideoRecorder();
}

type CloseableUiTransport = UiActionTransport & { close?(): Promise<void> };

function createExpoUiTransport(options: ExpoRecipeRunOptions): CloseableUiTransport {
  if (options.dryRun === true) {
    return dryRunUiTransport(true);
  }
  let metro: UiActionTransport | undefined;
  const resolveMetro = (): UiActionTransport => {
    metro ??= createMetroRecipeBridgeUiTransport({
      host: options.metroHost ?? process.env.FARMSLOT_RECIPE_METRO_HOST ?? '127.0.0.1',
      port: options.metroPort ?? resolveMetroRecipeBridgePort(),
    });
    return metro;
  };
  const native = resolveAgentDeviceTransport();
  if (!native) {
    return {
      execute(action, node, context) {
        return resolveMetro().execute(action, node, context);
      },
      observe(refs, node, context) {
        return resolveMetro().observe!(refs, node, context);
      },
    };
  }
  return {
    execute(action, node, context) {
      return isNativeUiAction(action)
        ? native.execute(action, node, context)
        : resolveMetro().execute(action, node, context);
    },
    observe(refs, node, context) {
      return native.observe!(refs, node, context);
    },
    close() {
      return native.close();
    },
  };
}

function resolveAgentDeviceTransport(): AgentDeviceUiTransport | undefined {
  const platform = normalizeNativePlatform(process.env.PLATFORM);
  const device =
    platform === 'ios'
      ? (process.env.IOS_SIMULATOR ?? process.env.SIMULATOR)
      : (process.env.ADB_SERIAL ?? process.env.ANDROID_SERIAL ?? process.env.ANDROID_DEVICE);
  const app = process.env.FARMSLOT_RECIPE_APP_ID;
  if (!platform || !device || !app) return undefined;
  const slot = process.env.FARMSLOT_SLOT_ID ?? path.basename(process.env.RUNTIME_DIR ?? 'local');
  const stateKey = (process.env.FARMSLOT_SLOT_ID ?? device).replace(/[^a-zA-Z0-9._-]/gu, '-');
  return createAgentDeviceUiTransport({
    platform,
    device,
    app,
    session: `farmslot-${slot}-${process.pid}`.replace(/[^a-zA-Z0-9._-]/gu, '-'),
    stateDir:
      process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR ??
      path.join(os.tmpdir(), 'farmslot-agent-device', stateKey),
  });
}

function normalizeNativePlatform(value: string | undefined): 'ios' | 'android' | undefined {
  if (value?.startsWith('ios')) return 'ios';
  if (value?.startsWith('android')) return 'android';
  return undefined;
}

function normalizeRecipeAdapter(value: string | undefined): 'ios' | 'android' | 'web' | undefined {
  return normalizeNativePlatform(value) ?? (value?.startsWith('web') ? 'web' : undefined);
}

function isNativeUiAction(action: string): boolean {
  return (NATIVE_UI_ACTIONS as readonly string[]).includes(action);
}

function dryRunUiTransport(isDryRun: boolean): UiActionTransport {
  return {
    async execute(action, node, context) {
      if (!isDryRun) {
        throw new Error(
          `${action} requires a project live UI bridge. Run with --dry-run for scaffold validation or configure a project transport.`,
        );
      }
      return {
        output: {
          ok: true,
          dryRun: true,
          action,
          nodeId: context.nodeId,
          intent: typeof node.intent === 'string' ? node.intent : undefined,
        },
      };
    },
    async observe() {
      return {};
    },
  };
}

function defaultArtifactsDir(recipePath: string): string {
  const slug = path
    .basename(recipePath)
    .replace(/\.recipe\.json$/u, '')
    .replace(/\.json$/u, '');
  return path.join('.agent', 'recipe-runs', `${slug}-${timestamp()}`);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}
