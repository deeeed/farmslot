import { type Command } from 'commander';

import { resolveRecipeLibrarySources } from '../core/library.js';

import { isRecipeCliError, reportRecipeCliError } from './error-output.js';
import { validateRecipeCliInput } from './support.js';

interface ValidateCommandOptions {
  actionManifest?: string;
  adapter?: string;
  artifactManifest?: string;
  artifactDir?: string;
  library: string[];
  json?: boolean;
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate a recipe and optional v1 artifact package')
    .argument('<recipe>', 'Path to recipe.json')
    .option('--action-manifest <manifest>', 'Runner action manifest JSON')
    .option('--adapter <name>', 'Active adapter for manifest capability validation')
    .option('--artifact-manifest <manifest>', 'Artifact manifest JSON')
    .option('--artifact-dir <dir>', 'Artifact package directory')
    .option(
      '--library <entry>',
      'Recipe library source as name=path or path (repeatable; order is precedence, first wins). Defaults to RECIPE_LIBRARY_PATH, then the personal library under the farmslot home — same resolution as run.',
      collectRepeatable,
      [] as string[],
    )
    .option('--json', 'Print validation result as JSON')
    .action(async (recipePath: string, options: ValidateCommandOptions) => {
      try {
        const librarySources = await resolveRecipeLibrarySources({
          cliEntries: options.library,
          recipePath,
        });
        const result = await validateRecipeCliInput({
          recipePath,
          actionManifestPath: options.actionManifest,
          adapter: options.adapter,
          artifactManifestPath: options.artifactManifest,
          artifactDir: options.artifactDir,
          ...(librarySources.length > 0 ? { librarySources } : {}),
        });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(
            `Recipe validation: ${result.status} (${result.summary.errors} errors, ${result.summary.warnings} warnings)`,
          );
          for (const finding of result.findings) {
            console.log(
              `- ${finding.severity} ${finding.code} ${finding.path}: ${finding.message}`,
            );
          }
        }
        if (result.status === 'invalid') process.exit(1);
      } catch (error) {
        if (!isRecipeCliError(error)) throw error;
        reportRecipeCliError(error, options.json === true);
      }
    });
}

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}
