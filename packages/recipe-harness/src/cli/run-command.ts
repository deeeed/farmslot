import { type Command } from 'commander';

import {
  getRecipeActionManifestActionNames,
  type RecipeActionManifestDocument,
} from '@farmslot/protocol';

import { createStandardCoreAdapters } from '../adapters/core.js';
import { createRecipeRunner } from '../core/runner.js';

import { readRecipeCliJsonFile, resolveRecipeCliPath } from './support.js';

interface RunCommandOptions {
  artifactsDir: string;
  actionManifest: string;
  projectRoot?: string;
  json?: boolean;
}

export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a recipe and write a v1 artifact package')
    .argument('<recipe>', 'Path to recipe.json')
    .requiredOption('--artifacts-dir <dir>', 'Directory where artifacts are written')
    .requiredOption('--action-manifest <manifest>', 'Runner action manifest JSON')
    .option('--project-root <dir>', 'Project root used by command/artifact adapters')
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
