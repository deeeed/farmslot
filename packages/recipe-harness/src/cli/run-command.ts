import { type Command } from 'commander';

import {
  getRecipeActionManifestActionNames,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../adapters/core.js';
import { createRecipeRunner } from '../core/runner.js';
import type { RecipeVideoRecordingOptions, RecordingTarget } from '../core/types.js';

import { parsePositiveInteger, readRecipeCliJsonFile, resolveRecipeCliPath } from './support.js';

interface RunCommandOptions {
  artifactsDir: string;
  actionManifest: string;
  projectRoot?: string;
  json?: boolean;
  recordVideo?: boolean | string;
  recordMaxFps?: string;
  recordMaxSize?: string;
  recordAppName?: string;
  recordWindowName?: string;
  recordWindowId?: string;
  recordPid?: string;
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a recipe and write a v1 artifact package')
    .argument('<recipe>', 'Path to recipe.json')
    .requiredOption('--artifacts-dir <dir>', 'Directory where artifacts are written')
    .requiredOption('--action-manifest <manifest>', 'Runner action manifest JSON')
    .option('--project-root <dir>', 'Project root used by command/artifact adapters')
    .option('--record-video [mode]', 'Record one whole-recipe MP4 when visual motion proof helps')
    .option('--record-max-fps <fps>', 'Maximum video frame rate')
    .option('--record-max-size <px>', 'Maximum recorded video dimension')
    .option('--record-app-name <name>', 'macOS app name for recording target')
    .option('--record-window-name <substring>', 'macOS window title substring for recording target')
    .option('--record-window-id <id>', 'macOS window id from `capture-helper list --json`')
    .option('--record-pid <pid>', 'macOS process id for recording target')
    .option('--json', 'Print run result as JSON')
    .action(async (recipePath: string, options: RunCommandOptions) => {
      const manifest = await readRecipeCliJsonFile(options.actionManifest);
      const runner = createRecipeRunner({
        actionManifest: manifest as RecipeActionManifestDocument,
        adapters: createStandardCoreAdapters({
          actions: getRecipeActionManifestActionNames(manifest),
        }),
        logger: console,
      });
      const result = await runner.run({
        recipePath: resolveRecipeCliPath(recipePath),
        artifactsDir: resolveRecipeCliPath(options.artifactsDir),
        projectRoot: options.projectRoot
          ? resolveRecipeCliPath(options.projectRoot)
          : resolveRecipeCliPath('.'),
        recordVideo: parseRecordVideoOptions(options),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Recipe run: ${result.status}`);
        console.log(`Artifacts: ${result.artifactManifestPath}`);
      }
      if (result.status !== 'pass') process.exit(1);
    });
}

function parseRecordVideoOptions(options: RunCommandOptions): false | RecipeVideoRecordingOptions {
  if (!options.recordVideo) return false;
  const mode =
    typeof options.recordVideo === 'string' && options.recordVideo !== 'true'
      ? options.recordVideo
      : 'full-run';
  if (mode === 'proof-window' || mode === 'proof_window') {
    throw new Error(
      '--record-video=proof-window is reserved for future focused clips; use --record-video=full-run for phase 1.',
    );
  }
  if (mode !== 'full-run' && mode !== 'off') {
    throw new Error('--record-video must be full-run or off.');
  }
  const target = parseRecordingTarget(options);
  return {
    mode,
    ...(options.recordMaxFps ? { maxFps: parsePositiveInteger(options.recordMaxFps) } : {}),
    ...(options.recordMaxSize ? { maxSize: parsePositiveInteger(options.recordMaxSize) } : {}),
    ...(target ? { target } : {}),
  };
}

function parseRecordingTarget(options: RunCommandOptions): RecordingTarget | undefined {
  if (options.recordPid) return { kind: 'pid', pid: parsePositiveInteger(options.recordPid) };
  if (options.recordWindowId) return { kind: 'window-id', windowId: options.recordWindowId };
  if (options.recordAppName || options.recordWindowName) {
    if (!options.recordAppName || !options.recordWindowName) {
      throw new Error('--record-app-name and --record-window-name must be provided together.');
    }
    return {
      kind: 'app-window',
      appName: options.recordAppName,
      windowName: options.recordWindowName,
    };
  }
  return undefined;
}
