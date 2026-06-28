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
  const adapters = [
    ...createRedactingCoreAdapters(actions),
    ...createStandardUiAdapters({
      actions,
      transport: createExpoUiTransport(options),
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

  return runner.run({
    recipePath: recipeAbsolutePath,
    artifactsDir,
    projectRoot,
    env: {
      FARMSLOT_RECIPE_ARTIFACTS_DIR: artifactsDir,
    },
    recordVideo: options.recordVideo,
  });
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

function createExpoUiTransport(options: ExpoRecipeRunOptions): UiActionTransport {
  if (options.dryRun === true) {
    return dryRunUiTransport(true);
  }
  return createMetroRecipeBridgeUiTransport({
    host: options.metroHost ?? process.env.FARMSLOT_RECIPE_METRO_HOST ?? '127.0.0.1',
    port: options.metroPort ?? resolveMetroRecipeBridgePort(),
  });
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
