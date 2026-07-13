import { Command } from 'commander';

import { registerAnalyticsCommand } from './commands/analytics.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerCertsCommand } from './commands/certs.js';
import { registerCompletionCommand } from './commands/completion.js';
import { registerConfigCommand } from './commands/config.js';
import { registerDispatchCommand } from './commands/dispatch.js';
import { registerDoctorCommand } from './commands/doctor.js';
import { registerDomainCommand } from './commands/domain.js';
import { registerFleetCommand } from './commands/fleet.js';
import { registerGatewayCommand } from './commands/gateway.js';
import { registerNodeCommand } from './commands/node.js';
import { registerPairCommand } from './commands/pair.js';
import { registerPRCommand } from './commands/pr.js';
import { registerProjectCommand } from './commands/project.js';
import { registerRecipeCommand } from './commands/recipe.js';
import { registerRoadmapCommand } from './commands/roadmap.js';
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
import { errorEnvelope } from './envelope.js';
import { OutputContext } from './output.js';

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

// exitOverride must be set before subcommands are created — commander copies
// inherited settings at .command() time, so a late override never reaches them.
program.exitOverride();

registerFleetCommand(program);
registerUpCommand(program);
registerGatewayCommand(program);
registerPairCommand(program);
registerSlotCommand(program);
registerDispatchCommand(program);
registerDomainCommand(program);
registerPRCommand(program);
registerRecipeCommand(program);
registerRoadmapCommand(program);
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
registerCertsCommand(program);

// parseAsync: async command actions (update) must reject through commander,
// not become unhandled rejections. exitOverride (set above) lets usage errors
// (unknown command, missing argument) emit a machine envelope before exiting.
try {
  await program.parseAsync();
} catch (err) {
  const commanderError = err as { code?: string; exitCode?: number };
  if (typeof commanderError?.code !== 'string' || !commanderError.code.startsWith('commander.')) {
    throw err;
  }
  const benign = ['commander.helpDisplayed', 'commander.help', 'commander.version'];
  if (benign.includes(commanderError.code)) {
    process.exitCode = commanderError.exitCode ?? 0;
  } else {
    // Commander already printed usage on stderr; machine consumers still need
    // exactly one envelope on stdout.
    if (process.argv.includes('--json') || !(process.stdout.isTTY ?? false)) {
      const command =
        process.argv
          .slice(2)
          .filter((arg) => !arg.startsWith('-'))
          .slice(0, 2)
          .join('.') || 'farmslot';
      new OutputContext(true).writeJson(
        errorEnvelope(
          command,
          Object.assign(err instanceof Error ? err : new Error(String(err)), {
            code: 'USAGE_ERROR',
            userAction: `Run \`farmslot ${command.replace(/\./g, ' ')} --help\` for usage.`,
          }),
        ),
      );
    }
    process.exitCode = commanderError.exitCode || 1;
  }
}
