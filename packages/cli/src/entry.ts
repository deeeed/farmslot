import { Command } from 'commander';

import { registerAnalyticsCommand } from './commands/analytics.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerConfigCommand } from './commands/config.js';
import { registerDispatchCommand } from './commands/dispatch.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerFleetCommand } from './commands/fleet.js';
import { registerGatewayCommand } from './commands/gateway.js';
import { registerNodeCommand } from './commands/node.js';
import { registerPairCommand } from './commands/pair.js';
import { registerPRCommand } from './commands/pr.js';
import { registerProjectCommand } from './commands/project.js';
import { registerRecipeCommand } from './commands/recipe.js';
import { registerRpcCommand } from './commands/rpc.js';
import { registerRunCommand } from './commands/run.js';
import { registerRunsCommand } from './commands/runs.js';
import { registerSlotCommand } from './commands/slot.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { registerUpCommand } from './commands/up.js';
import { registerUpdateCommand } from './commands/update.js';
import { registerWorkspaceCommand } from './commands/workspace.js';
import { loadCheckoutEnv } from './onboarding/env-file.js';
import { bootstrapFarmslotHome, repoRoot } from './onboarding/workspace.js';

// Load per-checkout .env.ports / .env (FARMSLOT_HOME, GW_URL, ports) before anything reads
// them; the shell environment always wins. Then recover a custom home from persisted state.
loadCheckoutEnv(repoRoot);
bootstrapFarmslotHome();

const program = new Command();

program
  .name('farmslot')
  .description('Farmslot fleet management CLI')
  .version('0.1.0')
  .option('--url <url>', 'Gateway WebSocket URL (overrides profiles; default ws://localhost:7777)')
  .option('--gateway <name>', 'Gateway profile to target (see: farmslot gateway list)')
  .option('--timeout <ms>', 'Timeout in ms', process.env.GW_TIMEOUT || '30000')
  .option('--json', 'Output raw JSON');

registerFleetCommand(program);
registerUpCommand(program);
registerGatewayCommand(program);
registerPairCommand(program);
registerSlotCommand(program);
registerDispatchCommand(program);
registerPRCommand(program);
registerRecipeCommand(program);
registerConfigCommand(program);
registerRpcCommand(program);
registerRunCommand(program);
registerRunsCommand(program);
registerCompletionCommand(program);
registerNodeCommand(program);
registerDoctorCommand(program);
registerWorkspaceCommand(program);
registerProjectCommand(program);
registerUpdateCommand(program);
registerUninstallCommand(program);
registerAuthCommands(program);
registerAnalyticsCommand(program);

// parseAsync: async command actions (update) must reject through commander,
// not become unhandled rejections.
await program.parseAsync();
