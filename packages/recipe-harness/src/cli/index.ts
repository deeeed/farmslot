import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

import { registerRunCommand } from './run-command.js';
import { registerValidateCommand } from './validate-command.js';

const CLI_VERSION = '0.1.0';

export function createRecipeHarnessProgram(): Command {
  const program = new Command();
  program
    .name('farmslot-recipe')
    .description('Farmslot v1 recipe harness CLI')
    .version(CLI_VERSION);

  registerValidateCommand(program);
  registerRunCommand(program);

  return program;
}

export async function runRecipeHarnessCli(argv: string[]): Promise<void> {
  await createRecipeHarnessProgram().parseAsync(argv, { from: 'user' });
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
