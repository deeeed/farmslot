import type { Command } from 'commander';

import { dim } from '../colors.js';
import { maybePromptGithubStar, starSupportHint } from '../onboarding/star-prompt.js';
import { OutputContext } from '../output.js';

export function registerStarCommand(program: Command): void {
  const star = program.command('star').description('GitHub star prompt helpers');

  star
    .command('prompt')
    .description('One-time interactive GitHub star prompt (used by install.sh)')
    .option('--tty <path>', 'read answers from a TTY device (e.g. /dev/tty)')
    .action(async (opts: { tty?: string }, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      if (output.json) {
        output.error('star prompt does not support --json');
        process.exit(1);
      }
      await maybePromptGithubStar({ ttyPath: opts.tty });
    });

  star
    .command('hint')
    .description('Print the gh repo star one-liner when GitHub CLI is authenticated')
    .action(async (_opts: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const hint = starSupportHint();
      if (output.json) {
        output.writeJson({ hint, repo: hint ? 'deeeed/farmslot' : null });
        return;
      }
      if (hint) output.write(`${dim(hint)}\n`);
    });
}