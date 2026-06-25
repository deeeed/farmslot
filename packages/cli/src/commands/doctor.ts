import type { Command } from 'commander';

import { bold, dim, green, red, yellow } from '../colors.js';
import { runDoctor } from '../onboarding/doctor.js';
import { maybePromptGithubStar, starSupportHint } from '../onboarding/star-prompt.js';
import { resolveWorkspace } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check prerequisites, runners, workspace, pool, and registered packs')
    .action(async (_: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const report = await runDoctor(resolveWorkspace());
      if (output.json) {
        output.writeJson(report);
      } else {
        for (const section of report.sections) {
          output.write(`${bold(section.title)}\n`);
          for (const check of section.checks) {
            const mark = !check.ok ? red('[FAIL]') : check.warn ? yellow('[WARN]') : green('[OK]');
            output.write(
              `  ${mark} ${check.name}${check.detail ? dim(`  ${check.detail}`) : ''}\n`,
            );
            if ((!check.ok || check.warn) && check.hint) {
              output.write(`         ${dim(`fix: ${check.hint}`)}\n`);
            }
          }
        }
        output.write(
          report.ok
            ? `\n${green('doctor: all checks passed')}\n`
            : `\n${red('doctor: checks failed')}\n`,
        );
      }
      if (!report.ok) process.exit(1);
      if (!output.json && report.ok) {
        const prompted = await maybePromptGithubStar();
        if (!prompted) {
          const hint = starSupportHint();
          if (hint) output.write(`${dim(hint)}\n`);
        }
      }
    });
}
