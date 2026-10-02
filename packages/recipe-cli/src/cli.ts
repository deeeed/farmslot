import { type Command, CommanderError } from 'commander';

import { createStandardCoreAdapters } from '@farmslot/recipe-harness';
import { createRecipeHarnessProgram } from '@farmslot/recipe-harness/cli';

import { printFailure, registerDiscoveryCommands } from './commands.js';
import { RECIPE_CLI_PACKAGE_VERSIONS, RECIPE_CLI_VERSION } from './version.js';

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
    packageVersions: RECIPE_CLI_PACKAGE_VERSIONS,
  });
  registerDiscoveryCommands(program, {
    commandName,
    // `run` registers the standard core handlers, so discovery reports the same set.
    handlers: createStandardCoreAdapters().map((adapter) => adapter.action),
    packageVersions: RECIPE_CLI_PACKAGE_VERSIONS,
  });
  return program;
}

/**
 * Run the CLI. Argument errors exit 2; with --json they print the error envelope instead of
 * commander's usage text.
 */
export async function runRecipeCli(argv: string[], options: RecipeCliOptions = {}): Promise<void> {
  const program = createRecipeCliProgram(options);
  const json = argv.includes('--json');
  for (const command of [program, ...program.commands]) {
    command.exitOverride();
    if (json) command.configureOutput({ writeErr: () => undefined });
  }
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    // --help and --version end through the same override with exit code 0.
    if (error.exitCode === 0) return;
    const command = program.commands.find((entry) => entry.name() === argv[0])?.name() ?? null;
    if (json)
      printFailure(
        command,
        {
          code: 'DISCOVERY_USAGE',
          message: error.message.replace(/^error: /u, ''),
          userAction: `${program.name()} ${command ?? ''} --help`.replace(/ {2}/gu, ' '),
        },
        true,
      );
    process.exitCode = 2;
  }
}
