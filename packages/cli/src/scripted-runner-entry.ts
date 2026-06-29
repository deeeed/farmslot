import { Command } from 'commander';

import { registerScriptedRunnerCommand } from './commands/scripted-runner.js';

const program = new Command();

program.name('farmslot').description('Farmslot scripted runner harness').version('0.1.0');

registerScriptedRunnerCommand(program);

await program.parseAsync();
