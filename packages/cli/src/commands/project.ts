import type { Command } from 'commander';

import { bold, dim, green, red } from '../colors.js';
import { projectAdd } from '../onboarding/add.js';
import { runDoctor } from '../onboarding/doctor.js';
import { resolveWorkspace } from '../onboarding/workspace.js';
import { OutputContext } from '../output.js';

export function registerProjectCommand(program: Command): void {
  const project = program.command('project').description('Project pack management (onboarding)');

  project
    .command('add')
    .description('Register a project pack: projects, repos, slots, validation')
    .argument('<source>', 'pack directory or git URL containing pack.json')
    .action(async (source: string, _: unknown, cmd: Command) => {
      const output = new OutputContext(cmd.optsWithGlobals().json ?? false);
      const ws = resolveWorkspace();
      if (!ws) {
        output.error('no workspace found — set FARMSLOT_WORKSPACE or run install.sh');
        process.exit(1);
      }

      const infos: string[] = [];
      try {
        const result = projectAdd(source, ws, {
          step: (s) => {
            if (!output.json) {
              output.write(`${green('[OK]')} ${s.label}${s.detail ? dim(`  ${s.detail}`) : ''}\n`);
            }
          },
          info: (msg) => {
            infos.push(msg);
            if (!output.json) output.write(`${dim(msg)}\n`);
          },
          childOutputToStderr: output.json,
        });

        // Every onboarding command ends with doctor.
        const report = await runDoctor(ws);
        if (output.json) {
          output.writeJson({
            pack: result.pack.name,
            action: result.action,
            slots: result.slots,
            notes: infos,
            doctor: report,
          });
        } else {
          output.write(`\n${bold(`pack ${result.pack.name}: ${result.action}`)}\n`);
          output.write(`  ${green('✓')} slots: ${result.slots.join(', ')}\n`);
          if (result.pack.action_sheet) {
            output.write(`\n${bold('Next steps')}\n${result.pack.action_sheet}\n`);
          }
          output.write(`\n${bold('doctor')}\n`);
          for (const section of report.sections) {
            for (const check of section.checks) {
              if (!check.ok) {
                output.write(
                  `${red('[FAIL]')} ${section.title}: ${check.name}${check.detail ? dim(`  ${check.detail}`) : ''}\n`,
                );
              }
            }
          }
          output.write(
            report.ok
              ? `${green('doctor: all checks passed')}\n`
              : `${red('doctor: checks failed')}\n`,
          );
        }
        if (!report.ok) process.exit(1);
      } catch (err) {
        output.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
