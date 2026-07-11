import os from 'node:os';
import path from 'node:path';

import {
  getRecipeActionManifestActionNames,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';
import {
  createCaptureHelperVideoRecorder,
  createRecipeRunner,
  createStandardUiAdapters,
  type RecipeVideoRecordingOptions,
  type RecordingTarget,
  type RecordingTargetProvider,
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
}

export function validateExpoRecipeDocument(
  recipePath: string = DEFAULT_EXPO_RECIPE_PATH,
  options: ExpoRecipeRunOptions = {},
) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  return validateRecipeCliInput({
    recipePath,
    actionManifestPath: options.manifestPath ?? DEFAULT_EXPO_RECIPE_MANIFEST_PATH,
    baseDir: projectRoot,
    artifactDir: options.artifactsDir,
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
  const actions = getRecipeActionManifestActionNames(manifest);
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
      env: {
        FARMSLOT_RECIPE_ARTIFACTS_DIR: artifactsDir,
      },
      recordVideo: options.recordVideo,
    });
  } finally {
    await transport.close?.();
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
  const metro = createMetroRecipeBridgeUiTransport({
    host: options.metroHost ?? process.env.FARMSLOT_RECIPE_METRO_HOST ?? '127.0.0.1',
    port: options.metroPort ?? resolveMetroRecipeBridgePort(),
  });
  const native = resolveAgentDeviceTransport();
  if (!native) return metro;
  return {
    execute(action, node, context) {
      return isNativeUiAction(action)
        ? native.execute(action, node, context)
        : metro.execute(action, node, context);
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
  const deviceKey = device.replace(/[^a-zA-Z0-9._-]/gu, '-');
  return createAgentDeviceUiTransport({
    platform,
    device,
    app,
    session: `farmslot-${slot}-${process.pid}`.replace(/[^a-zA-Z0-9._-]/gu, '-'),
    stateDir:
      process.env.FARMSLOT_AGENT_DEVICE_STATE_DIR ??
      path.join(os.tmpdir(), 'farmslot-agent-device', deviceKey),
  });
}

function normalizeNativePlatform(value: string | undefined): 'ios' | 'android' | undefined {
  if (value?.startsWith('ios')) return 'ios';
  if (value?.startsWith('android')) return 'android';
  return undefined;
}

function isNativeUiAction(action: string): boolean {
  return ['ui.press', 'ui.set_input', 'ui.scroll', 'ui.wait_for', 'ui.screenshot'].includes(action);
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
