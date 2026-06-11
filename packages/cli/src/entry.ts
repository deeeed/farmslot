import { Command } from 'commander';

import { registerCompletionCommand } from './commands/completion.js';
import { registerConfigCommand } from './commands/config.js';
import { registerDispatchCommand } from './commands/dispatch.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerFleetCommand } from './commands/fleet.js';
import { registerGatewayCommand } from './commands/gateway.js';
import { registerNodeCommand } from './commands/node.js';
import { registerPRCommand } from './commands/pr.js';
import { registerRecipeCommand } from './commands/recipe.js';
import { registerRpcCommand } from './commands/rpc.js';
import { registerRunCommand } from './commands/run.js';
import { registerSlotCommand } from './commands/slot.js';

const program = new Command();

program
  .name('farmslot')
  .description('Farmslot fleet management CLI')
  .version('0.1.0')
  .option('--url <url>', 'Gateway WebSocket URL', process.env.GW_URL || 'ws://localhost:7777')
  .option('--timeout <ms>', 'Timeout in ms', process.env.GW_TIMEOUT || '30000')
  .option('--json', 'Output raw JSON');

registerFleetCommand(program);
registerGatewayCommand(program);
registerSlotCommand(program);
registerDispatchCommand(program);
registerPRCommand(program);
registerRecipeCommand(program);
registerConfigCommand(program);
registerRpcCommand(program);
registerRunCommand(program);
registerCompletionCommand(program);
registerNodeCommand(program);
registerDoctorCommand(program);

program.parse();
