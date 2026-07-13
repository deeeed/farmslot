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
    // Non-commander failure that escaped an action (e.g. gateway profile
    // resolution in a command not yet envelope-wired): one envelope or one
    // teach-the-escape line, never a raw stack trace.
    if (process.argv.includes('--json') || !(process.stdout.isTTY ?? false)) {
      new OutputContext(true).writeJson(errorEnvelope(cliCommandFromArgv(), err));
    } else {
      new OutputContext(false).failure(err);
    }
    process.exitCode = 1;
  } else {
    const benign = ['commander.helpDisplayed', 'commander.help', 'commander.version'];
    if (benign.includes(commanderError.code)) {
      process.exitCode = commanderError.exitCode ?? 0;
    } else {
      // Commander already printed usage on stderr; machine consumers still need
      // exactly one envelope on stdout.
      if (process.argv.includes('--json') || !(process.stdout.isTTY ?? false)) {
        const command = cliCommandFromArgv();
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
}

/**
 * Dotted command path from argv, resolved against the registered commander
 * tree so positionals (slot ids, tickets) are never mistaken for subcommands.
 */
function cliCommandFromArgv(): string {
  const valueOptions = new Set(['--url', '--gateway', '--timeout']);
  const tokens: string[] = [];
  let scope: Command = program;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (valueOptions.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    const next = scope.commands.find(
      (candidate) => candidate.name() === arg || candidate.aliases().includes(arg),
    );
    if (!next) break;
    tokens.push(next.name());
    scope = next;
  }
  return tokens.join('.') || 'farmslot';
}
