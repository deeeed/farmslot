import { Command } from 'commander';

import { loadCheckoutEnv } from './onboarding/env-file.js';
import { bootstrapFarmslotHome, repoRoot } from './onboarding/workspace.js';
import { errorEnvelope } from './envelope.js';
import { DEFAULT_GATEWAY_URL } from './gateway-profiles.js';
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
  .option(
    '--url <url>',
    `Gateway WebSocket URL (uses a matching profile's credential; default ${DEFAULT_GATEWAY_URL})`,
  )
  .option('--gateway <name>', 'Gateway profile to target (see: farmslot gateway list)')
  .option('--timeout <ms>', 'Timeout in ms', process.env.GW_TIMEOUT || '30000')
  .option('--json', 'Output raw JSON');

// exitOverride must be set before subcommands are created — commander copies
// inherited settings at .command() time, so a late override never reaches them.
program.exitOverride();

// Task markers and node plumbing do not need the unrelated command graph.
const valueFlags = new Set(['--url', '--gateway', '--timeout']);
const invocation = process.argv.slice(2);
let commandName: string | undefined;
for (let index = 0; index < invocation.length; index++) {
  const token = invocation[index]!;
  if (valueFlags.has(token)) {
    index++;
    continue;
  }
  if (!token.startsWith('-')) {
    commandName = token;
    break;
  }
}
if (commandName === 'internal') {
  (await import('./commands/internal.js')).registerInternalCommand(program);
} else if (commandName === 'task') {
  (await import('./commands/task.js')).registerTaskCommand(program);
} else {
  (await import('./entry-commands.js')).registerCommands(program);
}

// parseAsync: async command actions (update) must reject through commander,
// not become unhandled rejections. exitOverride (set above) lets usage errors
// (unknown command, missing argument) emit a machine envelope before exiting.
try {
  await program.parseAsync();
} catch (err) {
  const commanderError = err as { code?: string; exitCode?: number };
  const isCommander =
    typeof commanderError?.code === 'string' && commanderError.code.startsWith('commander.');
  const benign = ['commander.helpDisplayed', 'commander.help', 'commander.version'];
  const args = process.argv.slice(2);
  const optionEnd = args.indexOf('--');
  const recipeStream =
    cliCommandFromArgv() === 'recipe.run' &&
    args.slice(0, optionEnd === -1 ? undefined : optionEnd).includes('--json-stream');
  if (recipeStream && !benign.includes(commanderError?.code ?? '')) {
    const shared = await import('@farmslot/recipe-cli/harness');
    process.exitCode = shared.failStream(
      new shared.JsonStreamWriter('run', true),
      err,
      isCommander ? 'USAGE_ERROR' : 'RUN_FAILED',
    );
  } else if (!isCommander) {
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
    if (benign.includes(commanderError.code ?? '')) {
      process.exitCode = commanderError.exitCode ?? 0;
    } else {
      // Commander already printed usage on stderr; machine consumers still need
      // exactly one envelope on stdout — except the `internal` plumbing verbs,
      // whose stdout is a raw data channel (scripts capture it): their usage
      // errors stay on stderr with a bare non-zero exit.
      const isInternalPlumbing = cliCommandFromArgv().startsWith('internal');
      if (
        !isInternalPlumbing &&
        (process.argv.includes('--json') || !(process.stdout.isTTY ?? false))
      ) {
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
