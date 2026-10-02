import { type Command } from 'commander';

import { createStandardCoreAdapters } from '@farmslot/recipe-harness';
import { createRecipeHarnessProgram } from '@farmslot/recipe-harness/cli';

import { registerDiscoveryCommands } from './commands.js';
import { RECIPE_CLI_VERSION } from './version.js';

export interface RecipeCliOptions {
  commandName?: string;
}

/** The `farmslot-recipe` program: the runner's run/validate plus the discovery commands. */
export function createRecipeCliProgram(options: RecipeCliOptions = {}): Command {
  const commandName = options.commandName ?? 'farmslot-recipe';
  const program = createRecipeHarnessProgram({
    commandName,
    description: 'Farmslot recipe CLI: run, validate and discover recipes and actions',
    version: RECIPE_CLI_VERSION,
  });
  registerDiscoveryCommands(program, {
    commandName,
    // `run` registers the standard core handlers, so discovery reports the same set.
    handlers: createStandardCoreAdapters().map((adapter) => adapter.action),
  });
  return program;
}

export async function runRecipeCli(argv: string[], options: RecipeCliOptions = {}): Promise<void> {
  await createRecipeCliProgram(options).parseAsync(argv, { from: 'user' });
}
