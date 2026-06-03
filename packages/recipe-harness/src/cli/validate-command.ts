import { type Command } from 'commander';

import { validateRecipeCliInput } from './support.js';

interface ValidateCommandOptions {
  actionManifest?: string;
  artifactManifest?: string;
  artifactDir?: string;
  json?: boolean;
}

export function registerValidateCommand(program: Command): void {
  program
    .command('validate')
    .description('Validate a recipe and optional v1 artifact package')
    .argument('<recipe>', 'Path to recipe.json')
    .option('--action-manifest <manifest>', 'Runner action manifest JSON')
    .option('--artifact-manifest <manifest>', 'Artifact manifest JSON')
    .option('--artifact-dir <dir>', 'Artifact package directory')
    .option('--json', 'Print validation result as JSON')
    .action(async (recipePath: string, options: ValidateCommandOptions) => {
      const result = await validateRecipeCliInput({
        recipePath,
        actionManifestPath: options.actionManifest,
        artifactManifestPath: options.artifactManifest,
        artifactDir: options.artifactDir,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `Recipe validation: ${result.status} (${result.summary.errors} errors, ${result.summary.warnings} warnings)`,
        );
        for (const finding of result.findings) {
          console.log(`- ${finding.severity} ${finding.code} ${finding.path}: ${finding.message}`);
        }
      }
      if (result.status === 'invalid') process.exit(1);
    });
}
