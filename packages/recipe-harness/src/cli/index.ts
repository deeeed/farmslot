import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { RECIPE_HARNESS_VERSION } from '../version.js';

import { registerRunCommand } from './run-command.js';
import { registerValidateCommand } from './validate-command.js';

export interface RecipeHarnessCliOptions {
  commandName?: string;
  description?: string;
  /** Version printed by --version; a host CLI reports its own. */
  version?: string;
  /** Package versions the host provides, checked against each library's `requires`. */
  packageVersions?: Readonly<Record<string, string>>;
}

export function createRecipeHarnessProgram(options: RecipeHarnessCliOptions = {}): Command {
  const program = new Command();
  program
    .name(options.commandName ?? 'farmslot-recipe')
    .description(options.description ?? 'Farmslot v1 recipe harness CLI')
    .version(options.version ?? RECIPE_HARNESS_VERSION);

  const context = options.packageVersions ? { packageVersions: options.packageVersions } : {};
  registerValidateCommand(program, context);
  registerRunCommand(program, context);
  return program;
}

export async function runRecipeHarnessCli(
  argv: string[],
  options: RecipeHarnessCliOptions = {},
): Promise<void> {
  await createRecipeHarnessProgram(options).parseAsync(argv, { from: 'user' });
}

// No top-level await: this module is a library entry too, and a CommonJS consumer can only
// require() an ES module that loads synchronously.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runRecipeHarnessCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
