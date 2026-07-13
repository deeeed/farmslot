import type { Command } from 'commander';

import { bold, dim, green, red, yellow } from '../colors.js';
import { errorEnvelope, isMachineMode, okEnvelope } from '../envelope.js';
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
      let report;
      try {
        report = await runDoctor(resolveWorkspace());
      } catch (err) {
        if (isMachineMode(output)) {
          const envelope = errorEnvelope('doctor', err);
          output.writeJson(envelope);
          process.exitCode = envelope.exitCode;
        } else {
          output.failure(err);
        }
        return;
      }
      if (isMachineMode(output)) {
        // Doctor "checks failed" is still a successful diagnosis — the envelope
        // stays ok with report data; the process exit code carries the verdict.
        const envelope = okEnvelope('doctor', report);
        output.writeJson(report.ok ? envelope : { ...envelope, exitCode: 1 });
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
      if (!report.ok) process.exitCode = 1;
      if (!isMachineMode(output) && report.ok) {
        const prompted = await maybePromptGithubStar();
        if (!prompted) {
          const hint = starSupportHint();
          if (hint) output.write(`${dim(hint)}\n`);
        }
      }
    });
}
