import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { registerFlowsCommand } from './flows-command.js';
import { registerRunCommand } from './run-command.js';
import { registerValidateCommand } from './validate-command.js';

const CLI_VERSION = '0.1.0';

export interface RecipeHarnessCliOptions {
  commandName?: string;
}

export function createRecipeHarnessProgram(options: RecipeHarnessCliOptions = {}): Command {
  const program = new Command();
  program
    .name(options.commandName ?? 'farmslot-recipe')
    .description('Farmslot v1 recipe harness CLI')
    .version(CLI_VERSION);

  registerValidateCommand(program);
  registerRunCommand(program);
  registerFlowsCommand(program);

  return program;
}

export async function runRecipeHarnessCli(
  argv: string[],
  options: RecipeHarnessCliOptions = {},
): Promise<void> {
  await createRecipeHarnessProgram(options).parseAsync(argv, { from: 'user' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runRecipeHarnessCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}
