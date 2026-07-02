import { type Command } from 'commander';

import {
  getRecipeActionManifestActionNames,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../adapters/core.js';
import { resolveRecipeLibrarySources } from '../core/library.js';
import { createRecipeRunner } from '../core/runner.js';
import type { RecipeVideoRecordingOptions } from '../core/types.js';

import {
  parsePositiveInteger,
  parseRecordingTarget,
  readRecipeCliJsonFile,
  resolveRecipeCliPath,
} from './support.js';

interface RunCommandOptions {
  artifactsDir: string;
  actionManifest: string;
  projectRoot?: string;
  library: string[];
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
    .option(
      '--library <entry>',
      'Recipe library source as name=path or path (repeatable; order is precedence, first wins). Defaults to RECIPE_LIBRARY_PATH, then the personal library under the farmslot home.',
      collectRepeatable,
      [] as string[],
    )
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
      const librarySources = await resolveRecipeLibrarySources({ cliEntries: options.library });
      const result = await runner.run({
        recipePath: resolveRecipeCliPath(recipePath),
        artifactsDir: resolveRecipeCliPath(options.artifactsDir),
        projectRoot: options.projectRoot
          ? resolveRecipeCliPath(options.projectRoot)
          : resolveRecipeCliPath('.'),
        recordVideo: parseRecordVideoOptions(options),
        ...(librarySources.length > 0 ? { librarySources } : {}),
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

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
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
